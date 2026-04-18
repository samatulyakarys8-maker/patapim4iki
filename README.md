# Damumed Sandbox + External Chrome Extension Agent

Dataset-first hackathon prototype for AIS Hack 3.0 HealthTech & RPA.

The project contains:

- local Damumed-like sandbox web app
- local backend API
- Chrome Extension MV3 external agent
- transcript-to-draft parser
- safe DOM operation engine with proof output
- Deepgram realtime voice navigator with browser/ElevenLabs fallbacks
- autopilot navigation and live form draft application

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
DEEPGRAM_API_KEY=...
DEEPGRAM_MODEL=nova-3
DEEPGRAM_LANGUAGE=multi
ELEVENLABS_API_KEY=...
ELEVENLABS_STT_MODEL=scribe_v2_realtime
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=openai/gpt-4o-mini
```

Do not commit `.env.local`.

## Demo Flow

1. Open schedule
2. In the extension click `Определить экран`
3. Click `Начать запись`
4. Say `Открой первичный прием`
5. Continue speaking medical observations; the agent updates the draft and can apply it automatically
6. Say `Перейди к выписному эпикризу` or `Открой диагнозы` to show voice DOM navigation
7. Say `Сохрани и закрой`
8. Verify schedule status `Выполнено`
9. Use proactive hint `Сформировать расписание процедур`

## Safety Model

The agent never writes directly from speech or LLM output into the DOM.

Flow:

```text
Deepgram audio -> transcript -> backend intent/parser -> safe DOM operations -> extension content script -> DOM proof/audit
```

Autopilot can execute safe navigation and field application. Final save still requires an explicit doctor command such as `сохрани` or `сохрани и закрой`.
