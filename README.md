# Auto Typer

A Chrome extension that types your text into the focused field with human-like speed, pauses and self-corrected typos. It can also rewrite the text with an AI model first.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Click the Auto Typer toolbar icon to open the side panel.

After changing any file, click the reload icon on the extension card and refresh the page you are typing into.

## Use

1. Paste or write your text in the side panel.
2. Optional: pick a tone and strength and click **Humanize with AI**. Review the result; **Undo** restores your original.
3. Click **Start typing**, then click into the field you want during the countdown.

While it types, the panel shows the text with typed letters in green and the current letter marked (red while a typo is being corrected).

### Hotkeys

| Keys | Action |
|---|---|
| `Alt+Shift+T` | Start typing in the focused field, or stop |
| `Alt+P` | Pause or resume |
| `Esc` | Stop |

Change them at `chrome://extensions/shortcuts`.

## Settings

| Setting | What it does |
|---|---|
| Speed | Target words per minute. Pauses and corrections make the real speed a little lower. |
| Typos | Share of letters that get a typo. Each one is noticed, backspaced and retyped, so the final text is exact. |
| Pauses | Scales the pauses after punctuation and line breaks, and the occasional longer ones. |
| Start delay | Countdown after **Start typing**, so you can click into the page. |
| Key events | How the text is delivered: by script, or as real key presses. See below. |

Speed, Typos and Pauses can be changed while a run is in progress.

### Key events

How the text reaches the page. Pick one under **Key events**; it applies from the next run.

| Mode | How it works | When to use |
|---|---|---|
| Insert by script (default) | The extension inserts the text itself. | Ordinary inputs, textareas and most rich editors. No setup. |
| Real keys: Chrome debugger | Keys are pressed through Chrome's debugger. | Editors that ignore script-inserted text, such as Google Docs. Chrome shows a "debugging this browser" banner during a run, and it cannot start while DevTools is open on the tab. |
| Real keys: System (Windows helper) | A small helper program presses the keys through Windows. | The same editors, with no banner and with DevTools open. Windows only; needs the one-time install below. |

In both real-key modes, new lines are sent as Shift+Enter, so forms are not submitted and chat messages are not sent.

#### Installing the Windows helper

Needs Python 3 on Windows. Copy the extension ID from the hint under **Key events** (or from `chrome://extensions`), then run this in the extension folder:

```
python native\install.py <extension-id>
```

It writes two small files in the `native` folder and one registry value under `HKEY_CURRENT_USER` for Chrome and for Edge. Run it again if the extension ID changes or the folder moves. To uninstall, run `python native\install.py --remove`.

System keys go to whatever has keyboard focus, so:

- Keep the page focused. Typing pauses when you click the side panel or another window, and continues when you click back into the field.
- Keys are only pressed while a browser window is in front, and not while you hold Ctrl, Alt, Win or Shift.
- Characters your keyboard layout has no key for (accents on a US layout, emoji) are inserted as Unicode input instead of key presses.

## AI rewrite

Open **AI settings** and choose a provider, paste your own API key and, if needed, change the model name. Supported: Google Gemini, Groq, OpenRouter, or any OpenAI-compatible endpoint.

- The key is stored only in this browser's extension storage.
- Your text is sent to the provider you choose.
- Long texts are rewritten in parts of about 1,500 characters.
- The panel warns you if a number from the original is missing from the rewrite.

Default model names can go out of date. If the provider returns an error about the model, check its current model list.

## Limits

- Does not run on browser pages (`chrome://`) or the Chrome Web Store.
- Typos are switched off in password fields.
- Editors that change text as you type (auto-closing brackets, autocorrect) can throw off typo corrections. Set Typos to off there.
- In single-line inputs, line breaks become spaces.
- Background tabs are slowed down by Chrome, so keep the tab visible.

## Files

| File | Role |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `engine.js` | Builds the timed keystroke plan, including typos |
| `content.js` | Types the plan into the focused field |
| `background.js` | Hotkeys, messaging, real key events |
| `native/autotyper_keys.py`, `native/install.py` | Optional Windows helper for System keys, and its installer |
| `sidepanel.html`, `sidepanel.css`, `sidepanel.js` | The side panel UI and the AI rewrite |
