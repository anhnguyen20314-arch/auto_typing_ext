"""Registers the Auto Typer key helper with Chrome and Edge for the current user.

    python install.py <extension-id>     install (or update)
    python install.py --remove           uninstall

The extension id is shown in the Auto Typer panel and on chrome://extensions.
Nothing is installed system-wide: this writes two small files next to this
script and one registry value per browser under HKEY_CURRENT_USER.
"""
import json
import os
import re
import sys
import winreg

HOST = 'com.autotyper.keys'
HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, HOST + '.json')
LAUNCHER = os.path.join(HERE, 'autotyper_keys.bat')
REG_KEYS = [
    r'Software\Google\Chrome\NativeMessagingHosts' + '\\' + HOST,
    r'Software\Microsoft\Edge\NativeMessagingHosts' + '\\' + HOST,
]


def install(ext_id):
    with open(LAUNCHER, 'w', encoding='ascii', newline='\r\n') as f:
        f.write('@echo off\n"%s" -u "%s"\n' % (sys.executable, os.path.join(HERE, 'autotyper_keys.py')))
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        json.dump({
            'name': HOST,
            'description': 'Auto Typer key helper',
            'path': LAUNCHER,
            'type': 'stdio',
            'allowed_origins': ['chrome-extension://%s/' % ext_id],
        }, f, indent=2)
    for key in REG_KEYS:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as k:
            winreg.SetValueEx(k, '', 0, winreg.REG_SZ, MANIFEST)
    print('Installed for extension', ext_id)
    print('Now pick "System keys" in the Auto Typer panel.')


def remove():
    for key in REG_KEYS:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
        except FileNotFoundError:
            pass
    for path in (MANIFEST, LAUNCHER):
        if os.path.exists(path):
            os.remove(path)
    print('Removed.')


def main():
    args = sys.argv[1:]
    if args == ['--remove']:
        return remove()
    if len(args) != 1 or not re.fullmatch(r'[a-p]{32}', args[0]):
        sys.exit(__doc__)
    install(args[0])


if __name__ == '__main__':
    main()
