# Changelog

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
