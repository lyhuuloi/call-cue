# Changelog

Every version bump gets an entry here (a test fails if the current version has none).

## 0.3.0

- **Add cards from a document, in the page.** Press **📥 Add from a document**, drop a
  PDF, Word file (.docx), text, Markdown, HTML or CSV file (or paste text), check the
  cards it made, and save. No JSON editing needed.
- **Two ways to make the cards.** *Split by headings and questions* runs on your device
  and sends nothing anywhere. *Let the AI write the cards* sends the document text to
  the AI you configured (offered only when a key is set).
- **Saving.** The cards go to `call-cue-kb.json` in the folder you started from; the
  previous file is kept as `call-cue-kb.json.bak`. You can add to your cards or replace
  them, or download the file instead of saving. The bundled example is never changed.
- **Web demo.** Imported cards stay in your browser; **↩️ Back to the example** removes them.
- Files are read in the browser. PDF reading uses the bundled
  [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0); nothing is downloaded at run time.

## 0.2.0

- **More AI providers.** One key switches AI on: Claude, ChatGPT (OpenAI), DeepSeek,
  OpenCode, or any OpenAI-compatible endpoint (Ollama, OpenRouter, LM Studio).
  `CALL_CUE_AI` picks one when several are set; `CALL_CUE_AI_MODEL` overrides the model.
- **The chat model now also picks the card**, so a Jev key is no longer needed for AI
  matching. With `TYPESAFE_API_KEY` set, Jev still does the picking.
- **Simpler setup.** `call-cue init` creates `call-cue-kb.json` and `.env`; both are
  picked up automatically from the folder you start in. The browser opens by itself
  (`--no-open` turns that off).
- **New design.** The live answer stays on the left while the cards scroll on the right,
  larger answer text, a light/dark switch, a phone layout, and clearer first-run steps.
  Click any card to put it on the stage.
- The page says what is missing when the browser cannot listen or no AI key is set.

## 0.1.0

- First release: live answer cards from a JSON knowledge base, on-device captions and
  translation, optional Jev matching and Claude drafts, web demo.
