"""Auto Typer key helper (Windows).

A Chrome native-messaging host. The extension sends one JSON message per key
event and this program presses the key with the Windows SendInput API, so the
key reaches the focused window the same way a keyboard press does.

Messages (each gets a reply with the same "id"):
  {"op": "hello"}                       -> key map for the active keyboard layout
  {"op": "key", "scan": n, "down": b}   -> press or release a key by scan code
  {"op": "text", "text": "..."}         -> insert characters that have no key
  {"op": "reset"}                       -> release every key still held

Keys are only pressed while a browser window is in front. Releases always go
through, so a key is never left stuck down.

Set AUTOTYPER_DRY=1 to log instead of pressing keys (used for testing).
"""
import ctypes
import json
import os
import struct
import sys
import time
from ctypes import wintypes

VERSION = 1
DRY = os.environ.get('AUTOTYPER_DRY') == '1'

BROWSERS = {'chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe', 'opera.exe', 'chromium.exe'}

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_SCANCODE = 0x0008
MAPVK_VK_TO_VSC = 0
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

user32 = ctypes.WinDLL('user32', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

ULONG_PTR = ctypes.c_size_t


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD), ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD), ('dwExtraInfo', ULONG_PTR)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG), ('mouseData', wintypes.DWORD),
                ('dwFlags', wintypes.DWORD), ('time', wintypes.DWORD), ('dwExtraInfo', ULONG_PTR)]


class _INPUTunion(ctypes.Union):
    _fields_ = [('ki', KEYBDINPUT), ('mi', MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', wintypes.DWORD), ('union', _INPUTunion)]


user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.SendInput.restype = wintypes.UINT
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetAsyncKeyState.restype = ctypes.c_short
user32.GetKeyboardLayout.argtypes = [wintypes.DWORD]
user32.GetKeyboardLayout.restype = wintypes.HKL
user32.VkKeyScanExW.argtypes = [wintypes.WCHAR, wintypes.HKL]
user32.VkKeyScanExW.restype = ctypes.c_short
user32.MapVirtualKeyExW.argtypes = [wintypes.UINT, wintypes.UINT, wintypes.HKL]
user32.MapVirtualKeyExW.restype = wintypes.UINT
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                                ctypes.POINTER(wintypes.DWORD)]
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

held = set()  # scan codes currently down


def log(*parts):
    print(*parts, file=sys.stderr, flush=True)


def send(scan, flags):
    if DRY:
        log('send', hex(scan), hex(flags))
        return
    inp = INPUT(type=INPUT_KEYBOARD)
    inp.union.ki = KEYBDINPUT(0, scan, flags, 0, 0)
    if user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT)) != 1:
        raise ctypes.WinError(ctypes.get_last_error())


def foreground():
    """(thread id, executable name) of the window in front."""
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return 0, ''
    pid = wintypes.DWORD()
    tid = user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    name = ''
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if handle:
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = wintypes.DWORD(1024)
            if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                name = buf.value.rsplit('\\', 1)[-1].lower()
        finally:
            kernel32.CloseHandle(handle)
    return tid, name


def browser_in_front():
    return DRY or foreground()[1] in BROWSERS


VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN = 0x10, 0x11, 0x12, 0x5B, 0x5C
SHIFT_SCANS = (0x2A, 0x36)


def user_modifier_down():
    """True while the user holds Ctrl, Alt, Win or Shift (e.g. from a hotkey).

    A letter pressed on top of those would become a shortcut.
    """
    if DRY:
        return False
    keys = [VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN]
    if not any(s in held for s in SHIFT_SCANS):  # a Shift we did not press ourselves
        keys.append(VK_SHIFT)
    return any(user32.GetAsyncKeyState(vk) & 0x8000 for vk in keys)


def blocked():
    """Reason a key must not be pressed right now, or ''."""
    if not browser_in_front():
        return 'the browser is not the front window'
    for _ in range(75):  # give a hotkey up to 1.5 s to be released
        if not user_modifier_down():
            return ''
        time.sleep(0.02)
    return 'a modifier key is being held'


def key_map():
    """Printable ASCII -> [scan code, needs Shift] for the layout of the window in front.

    Characters the layout cannot produce with a plain or shifted key are left
    out; the extension sends those with the "text" message.
    """
    layout = user32.GetKeyboardLayout(foreground()[0])
    result = {}
    for code in range(32, 127):
        ch = chr(code)
        res = user32.VkKeyScanExW(ch, layout)
        if res == -1:
            continue
        vk, mods = res & 0xFF, (res >> 8) & 0xFF
        if mods not in (0, 1):  # needs Ctrl or Alt (AltGr)
            continue
        scan = user32.MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC, layout)
        if scan:
            result[ch] = [scan, mods == 1]
    return result


def release_all():
    for scan in list(held):
        try:
            send(scan, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP)
        except OSError:
            pass
    held.clear()


def handle(msg):
    op = msg.get('op')
    if op == 'hello':
        return {'ok': True, 'version': VERSION, 'map': key_map()}
    if op == 'key':
        scan = int(msg.get('scan') or 0)
        if not 0 < scan < 0x80:
            return {'ok': False, 'error': 'bad scan code'}
        if msg.get('down'):
            why = blocked()
            if why:
                return {'ok': False, 'retry': True, 'error': why}
            if scan in held:  # same key again before its release arrived
                send(scan, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP)
            send(scan, KEYEVENTF_SCANCODE)
            held.add(scan)
        elif scan in held:
            send(scan, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP)
            held.discard(scan)
        return {'ok': True}
    if op == 'text':
        why = blocked()
        if why:
            return {'ok': False, 'retry': True, 'error': why}
        data = str(msg.get('text') or '').encode('utf-16-le')
        for i in range(0, len(data), 2):
            unit = data[i] | (data[i + 1] << 8)
            send(unit, KEYEVENTF_UNICODE)
            send(unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
        return {'ok': True}
    if op == 'reset':
        release_all()
        return {'ok': True}
    return {'ok': False, 'error': 'unknown message'}


def read_message(stream):
    head = stream.read(4)
    if len(head) < 4:
        return None
    size = struct.unpack('<I', head)[0]
    if size > 1 << 20:
        return None
    body = stream.read(size)
    if len(body) < size:
        return None
    return json.loads(body.decode('utf-8'))


def write_message(stream, obj):
    body = json.dumps(obj).encode('utf-8')
    stream.write(struct.pack('<I', len(body)) + body)
    stream.flush()


def main():
    if sys.platform != 'win32':
        sys.exit('Auto Typer key helper only runs on Windows.')
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    try:
        while True:
            msg = read_message(stdin)
            if msg is None:
                break
            try:
                reply = handle(msg)
            except Exception as err:  # report and keep serving
                reply = {'ok': False, 'error': str(err)}
            reply['id'] = msg.get('id')
            write_message(stdout, reply)
    finally:
        release_all()


if __name__ == '__main__':
    main()
