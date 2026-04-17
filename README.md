# Damumed Sandbox + External Chrome Extension Agent

Dataset-first hackathon prototype for AIS Hack 3.0 HealthTech & RPA.

The project contains:

- local Damumed-like sandbox web app
- local backend API
- Chrome Extension MV3 external agent
- transcript-to-draft parser
- safe preview/apply flow
- realtime speech-to-text integration hooks

## Run Locally

```bash
npm install
npm start
```

Open:

```text
http://localhost:3030
```

## Load Chrome Extension

1. Open `chrome://extensions`
2. Enable developer mode
3. Click `Load unpacked`
4. Select the `extension` folder from this repository
5. Open `http://localhost:3030`
6. Open a patient inspection form
7. Open the extension side panel

## Environment Variables

Create `.env.local` from `.env.example`:

```bash
cp .env.example .env.local
```

Required only for realtime/LLM features:

```text
ELEVENLABS_API_KEY=...
ELEVENLABS_STT_MODEL=scribe_v2_realtime
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=openai/gpt-4o-mini
```

Do not commit `.env.local`.

## Demo Flow

1. Open schedule
2. Click `Исполнить` on a patient slot
3. In the extension click `Определить экран`
4. Use `Начать запись` or paste transcript fallback
5. Review `Черновик формы`
6. Click `Применить в форму`
7. Click `Сохранить и закрыть`
8. Return to schedule and verify status `Выполнено`

## Safety Model

The agent never writes directly from speech or LLM output into the DOM.

Flow:

```text
audio/transcript -> backend parser -> draft patches -> extension preview -> manual apply -> save
```

The extension receives structured DOM operations only after preview is created.
