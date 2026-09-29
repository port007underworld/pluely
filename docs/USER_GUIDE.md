# Runningbord User Guide

Runningbord is a small AI assistant that floats on top of your screen. During a meeting, interview or coding session it can see your screen, hear the meeting, and answer the question you were just asked, usually in a few seconds.

This guide covers everything it can do. If you're new, read **Getting started** and **Your first meeting**, and dip into the rest when you need it.

---

## Contents

1. [Getting started](#1-getting-started)
2. [Your first meeting in 5 minutes](#2-your-first-meeting-in-5-minutes)
3. [The overlay](#3-the-overlay)
4. [Asking questions](#4-asking-questions)
5. [The answer panel](#5-the-answer-panel)
6. [Meeting features](#6-meeting-features)
7. [Making it yours](#7-making-it-yours)
8. [Your chats](#8-your-chats)
9. [Keyboard shortcuts and commands](#9-keyboard-shortcuts-and-commands)
10. [Privacy: what stays on your computer](#10-privacy-what-stays-on-your-computer)
11. [Updates](#11-updates)
12. [Troubleshooting](#12-troubleshooting)
13. [Glossary](#13-glossary)

> **Key names.** Shortcuts are written for Mac: **⌘** is Command, **⇧** is Shift. On Windows, use **Ctrl** instead of ⌘.

---

## 1. Getting started

### What you need

- A Mac (Apple Silicon or Intel, macOS 11 or later) or a Windows PC.
- An **API key** from an AI provider such as OpenAI, Anthropic (Claude), Google (Gemini) or Groq. Runningbord doesn't include an AI of its own; it connects to the one you choose. You pay that provider directly for what you use, usually a fraction of a cent per question.

### Install

**Mac**
1. Download the `.dmg` from the project's GitHub **Releases** page and drag Runningbord into Applications.
2. The first time, macOS may say it can't check the app for malicious software. The app is signed but not notarized with Apple, so this is expected. **Right-click the app → Open → Open.** You only do this once.

**Windows**
1. Download the installer (`.exe` or `.msi`) from **Releases** and run it.
2. If Windows SmartScreen appears, click **More info → Run anyway**.

### First-run setup

The first time you open Runningbord, a short setup walks you through three steps. You can skip any of them and come back later from **App Settings → Setup Guide → Run setup again**.

1. **AI provider.** Pick your provider, paste your API key, and enter a model name (for example `gpt-4o-mini`, `claude-haiku-4-5` or `gemini-2.5-flash`). The key is stored in your system keychain, not in a plain file.
2. **Permissions** (Mac only). Grant:
   - **Screen Recording**, so it can take screenshots. macOS asks you to restart the app afterwards.
   - **System Audio Recording**, so it can hear the meeting.
   - **Microphone** (optional), so it can also hear you.
3. **Transcription.** Download a speech-recognition model so meetings are transcribed **on your computer**. **Base (English)**, about 142 MB, is a good start.

---

## 2. Your first meeting in 5 minutes

Here's a typical flow from start to finish. Every step is explained in more detail later.

**Before the meeting**
1. Open the dashboard with **⌘⇧D** and go to **Meeting**.
2. Optional: paste the calendar invite or agenda into **Prepare for a Meeting** and click **Prepare**. You get a short brief, and with one click Runningbord picks the right style of answers, remembers the brief and pins key facts.
3. Optional: in **My Context**, upload your resume or notes so answers sound like you.

**During the meeting**

4. Turn on **Meeting mode**: click the waveform button in the overlay, or press **⌘⇧M**. A green dot means it's listening.
5. When someone asks you something, press **⌘⇧S**. Runningbord takes a screenshot, adds what was just said, and answers.
6. Or turn on **Auto-answer** (the question-mark button, or **⌘⇧U**): questions from other people are answered automatically once they stop talking.
7. Learned something important? Type `/pin Budget is $40k` in the overlay, and every answer after that takes it into account.

**After the meeting**

8. Turn Meeting mode off. If **meeting notes** are on, a summary with decisions and action items is saved in **Chats**.

---

## 3. The overlay

The overlay is the slim bar that floats above your other windows.

```
┌────────────────────────────────────────────────────────────────────────┐
│ [ Ask anything, or /pin a fact…   📌2  💬4 ]  📷  〰  ❓  📎  ⚙  ⠿   │
│ ▔▔▔▔▔▔▔▔▔▔▔▔▔ (talk-time bar, only in meetings with your mic on)      │
└────────────────────────────────────────────────────────────────────────┘
```

| Part | What it does |
|---|---|
| **Input box** | Type a question and press **Enter**. |
| **📌 2** | Number of pinned facts. Hover to see them, click to manage them. |
| **💬 4** | Number of messages in the current conversation. Click to see the whole conversation. |
| **📷 Camera** | Take a screenshot and ask about it (same as **⌘⇧S**). |
| **〰 Waveform** | Turn **Meeting mode** on or off. Green dot: listening. Red: it couldn't start; hover for the reason. |
| **❓ Question mark** | Turn **Auto-answer** on or off. Only shown while Meeting mode is on. A blue dot means it's on. |
| **📎 Paperclip** | Attached files and screenshots waiting to be sent. |
| **⚙ Gear** | Open the dashboard. A blue dot means an update is available. |
| **⠿ Handle** | Drag to move the overlay. |

**Handy to know**
- **Show or hide** the overlay with **⌘\\**.
- **Move** it with **⌘ + arrow keys**, or drag the handle.
- **Jump to the input box** from any app with **⌘⇧I**.
- The overlay is set to be **left out of screenshots and screen sharing**. Check this once with your meeting app before relying on it.
- In **App Settings** you can hide the Dock/taskbar icon and choose whether the overlay stays on top of other windows. Under **Cursor & Shortcuts** you can make the mouse pointer invisible while it's over the overlay.

---

## 4. Asking questions

### Type a question
Click the input box (or press **⌘⇧I**), type, and press **Enter**.

### Ask about your screen
Press **⌘⇧S** or click the camera. You can choose what happens on the **Screenshot** page:
- **What to capture:** the full screen, or an area you select by dragging.
- **After capturing:**
  - **Send it immediately** with standard instructions ("what do I need right now?"). This is the fastest option.
  - **Attach it** so you can type your own question first.

If **Meeting mode** is on, the screenshot also includes a transcript of what was just said, so the AI answers the question you were asked, not just what's on screen.

### Attach files and images
Paste an image (**⌘V**) into the input box, or use the paperclip. You can attach up to 6 files per question.

### Fast or slow model
If you entered both a **Fast** and a **Slow** model for your provider, the answer panel shows **Fast / Slow** buttons. Fast is quicker and cheaper; Slow is for harder problems.

### Start fresh
Press **⌘⇧N** (or the **new chat** button in the answer panel) to start a new conversation. The AI forgets the previous one. Conversations also restart by themselves after 10 minutes of inactivity; you can change this under **Responses → Conversation Memory**.

---

## 5. The answer panel

Answers appear in a panel under the overlay.

```
┌ AI Response · Context: 4/4 msgs     ‹ 2/3 ›  Fast Slow  💬 ✚ ⧉ ✕ ┐
│ Auto-answer: Why did you pick Postgres over DynamoDB?              │
│                                                                    │
│ Postgres fits because…  (the answer)                               │
│                                                                    │
│ LIKELY NEXT                                                        │
│ [ How would you handle schema migrations? ]                        │
│ [ What about read replicas? ]                                      │
│                                                                    │
│ (Shorter) (Simpler) (Example) (Ask next) (Copy code)               │
└────────────────────────────────────────────────────────────────────┘
```

| Feature | How to use it |
|---|---|
| **Flip between answers** | **‹ ›** in the header, or **⌘[** and **⌘]**. If you go back to read an older answer, you stay there even when a new one arrives; click **Back to latest answer** when you're ready. |
| **Likely next** | Two or three questions that might come up next. Click one to have its answer ready before it's asked. Turn off under **Responses → Suggested Follow-ups**. |
| **Quick actions** | **Shorter**, **Simpler**, **Example** and **Ask next** rework the last answer. Shortcuts: **⌘1**, **⌘2**, **⌘3**, **⌘4**. |
| **Copy code** | Copies the last code block. Works from any app with **⌘⇧Y**. |
| **⧉ Copy** | Copies the whole answer you're looking at. |
| **💬 Conversation view** | Shows the whole conversation (**⌘K**). |
| **✕** | Stops an answer that's still being written, or closes the panel. |
| **Scroll** | **↑ / ↓** arrow keys. |

---

## 6. Meeting features

All of these are on the **Meeting** page of the dashboard.

### Meeting mode
Meeting mode lets Runningbord hear the meeting through your computer's audio output: Zoom, Meet, Teams, a browser tab, anything. Turn it on in the overlay or with **⌘⇧M**.

**Where transcription happens:**
- **On this device** (recommended): free and private; audio never leaves your computer. Needs a one-time model download. Bigger models are more accurate but slower.
- **Cloud provider:** sends audio to a speech-to-text service you configure. Good on slow machines.
- **Raw audio:** sends the audio file to AI providers that accept audio, such as Gemini. For advanced users.

**Useful options:**
- **Live transcription** (on by default): transcribes as people talk, so answers are instant. Needed for Auto-answer, meeting notes, People and Talk Time.
- **Also capture my microphone:** adds your own voice, labelled "You". Headphones give the cleanest result.
- **Tell speakers apart** (Mac): labels different voices as Speaker 1, Speaker 2… Needs a small extra download.
- **Send with each shortcut press:** how much recent conversation goes with a screenshot (default: last 5 minutes).

The live preview on the Meeting page shows lines as they're transcribed, which is handy for checking it works.

### Auto-answer
When someone **else** in the meeting asks a question, Runningbord answers it automatically, without you pressing anything.

- Turn it on under **Live transcription → Answer questions automatically**, then switch it on and off in meetings with the **❓** button or **⌘⇧U**.
- It only listens to other people, never your microphone.
- It waits until they've **finished speaking**. You choose how long to wait (1, 2, 3 or 5 seconds); longer waits keep long, multi-part questions together.
- If a new question comes in while an answer is still being written, it's answered straight after.
- It won't overwrite something you're typing.
- Optional: **Include a screenshot**, for questions about what's on screen.
- Each answer is labelled **"Auto-answer: …"** so you know where it came from.

> Each automatic answer is a normal AI request, so it costs the same as pressing the shortcut.

### Pinned facts
Facts the AI should treat as true for this meeting, such as "Budget is $40k", "They use Go and Postgres" or "Decision by Friday".

- **Add:** type `/pin your fact` in the overlay and press Enter, or use **Pinned Facts** on the Meeting page.
- **See:** hover the 📌 badge in the overlay.
- **Clear:** type `/unpin all`, or use **Clear all** on the Meeting page.
- Up to 30 facts. They stay until you clear them.

### People (speaker names)
Lists everyone heard so far, with the last thing each person said, so you can tell who's who. Type a name next to "Speaker 1" (or "Them") and answers, transcripts and notes will use it.
- Names reset when the next meeting starts, because the numbering starts over.
- Without **Tell speakers apart**, everyone else is "Them". In a one-on-one call, naming "Them" is enough.

### Talk time
Shows how much you've talked compared with everyone else. Needs **Also capture my microphone**.
- **Meeting page:** each person's share, your speaking pace (words per minute), your longest stretch of talking, and how long you've been talking right now.
- **Overlay:** a thin bar at the bottom shows your share. It turns **amber** if you're above 60% or have been talking for 90 seconds straight. Hover for the numbers.
- Rules of thumb: a comfortable pace is 130–160 words a minute; on sales calls, listen more than you talk; in interviews, keep single answers under two minutes.

### Meeting notes
When you turn Meeting mode off, Runningbord can write notes: **summary, key points, decisions, action items and open questions**. They're saved in **Chats** together with the full transcript.
- Turn on **Write notes when Meeting mode is turned off**. It's off by default because the whole transcript is sent to your AI provider.
- Only meetings of two minutes or longer get notes.
- **Generate now** makes notes on demand, even halfway through a meeting.

### Prepare for a meeting
Paste a calendar invite, agenda, email thread or job description and click **Prepare**. You get:
- a title and a two-or-three-sentence summary of what the meeting is for;
- attendees and agenda;
- up to five **facts** worth keeping in mind;
- up to five **questions** you're likely to be asked.

Then choose what to apply:
- **Switch profile / prompt:** uses the matching profile, or the right prompt for an interview, sales call or team meeting.
- **Add the brief to My Context:** replaces the previous brief.
- **Pin the facts:** replaces your current pins.

Nothing changes until you click **Apply**.

---

## 7. Making it yours

### System prompts: how the AI answers
**System prompts** in the sidebar. Choose a built-in style:

| Preset | Best for |
|---|---|
| **Coding Copilot** (default) | Quick, direct answers during technical work. |
| **Technical Interview** | Step-by-step answers you can talk through: approach, code, complexity, edge cases, follow-ups. Also system design and behavioral (STAR) answers. |
| **Debugging** | Root cause first, then the exact fix. |
| **Code Review** | Real bugs and risks, no style nitpicks. |
| **Sales Call** | What to say next, handling objections, discovery questions. |
| **Team Meeting** | Short answers for standups and planning, status updates, action items. |

Click **Customize** to make an editable copy, or write your own prompt from scratch.

### My Context: background about you
Upload your **resume**, a **job description** or **notes** (PDF, TXT or Markdown), or type them in. The AI uses them when relevant, for example answering "tell me about yourself" with your real experience. It's told never to invent experience you don't have.
- Each item has its own on/off switch, so you can keep several and turn on only what fits today.
- Keep it focused: everything that's switched on is sent with every question.

### Profiles: settings for each kind of meeting
**Profiles** in the sidebar. A profile remembers:
- which system prompt you use;
- which My Context items are on;
- your fast and slow models;
- your response settings.

Create one from your current settings, or from the **Interview**, **Sales call** or **Team meeting** templates. Click **Use** to switch. Changes you make while a profile is active are saved to it when you switch away. API keys aren't part of profiles.

### Responses
- **Response Length:** short, medium or automatic.
- **Language:** answer in a language other than English.
- **Suggested Follow-ups:** the "Likely next" questions (on by default).
- **Auto-Scroll:** follow the answer as it's written.
- **Conversation Memory:** when to start a new conversation automatically, and how much history to send with each question.

### Screenshot
What a screenshot captures (full screen or an area), whether it's sent right away or attached, the instructions sent with it, and image compression.

---

## 8. Your chats

**Chats** in the sidebar lists every conversation, grouped by day.

- **Search** looks inside messages, meeting transcripts and notes, not just titles, and shows the matching text.
- **Open** a chat to read it, **Download** it as Markdown, **Open in Overlay** to continue it, or **Delete** it.
- **App Settings → Chat History:**
  - **Delete old conversations** automatically after 1, 7, 30, 90 or 365 days. The default is to keep them forever.
  - **Export all conversations** as Markdown (easy to read) or JSON (keeps every detail). Attached images aren't included.
  - **Delete all conversations.**

---

## 9. Keyboard shortcuts and commands

### Work from any app

| Action | Mac | Windows |
|---|---|---|
| Take a screenshot and ask | ⌘⇧S | Ctrl+Shift+S |
| Meeting mode on/off | ⌘⇧M | Ctrl+Shift+M |
| Auto-answer on/off | ⌘⇧U | Ctrl+Shift+U |
| Copy last code block | ⌘⇧Y | Ctrl+Shift+Y |
| New conversation | ⌘⇧N | Ctrl+Shift+N |
| Jump to the input box | ⌘⇧I | Ctrl+Shift+I |
| Show/hide the overlay | ⌘\\ | Ctrl+\\ |
| Open/close the dashboard | ⌘⇧D | Ctrl+Shift+D |
| Move the overlay | ⌘ + arrow keys | Ctrl + arrow keys |

Change any of these under **Cursor & Shortcuts**.

### While the answer panel is open

| Action | Mac | Windows |
|---|---|---|
| Previous / next answer | ⌘[ / ⌘] | Ctrl+[ / Ctrl+] |
| Shorter / Simpler / Example / Ask next | ⌘1 / ⌘2 / ⌘3 / ⌘4 | Ctrl+1 … Ctrl+4 |
| Whole conversation view | ⌘K | Ctrl+K |
| Scroll the answer | ↑ / ↓ | ↑ / ↓ |
| Send a question | Enter | Enter |

### Commands you can type in the overlay

| Type | What it does |
|---|---|
| `/pin <fact>` | Remember a fact for every answer in this meeting. |
| `/unpin all` | Forget all pinned facts. |

---

## 10. Privacy: what stays on your computer

**Stays on your computer**
- Chats, transcripts and meeting notes (a local database).
- Settings, profiles, My Context and pinned facts.
- API keys, in the **macOS Keychain** or **Windows Credential Manager**.
- Meeting audio, when you use **On this device** transcription.

**Sent to your AI provider, only when you ask something** (a question, a screenshot, auto-answer, notes or meeting prep)
- Your question, and the screenshot if there is one.
- Recent conversation history.
- The recent meeting transcript, when Meeting mode is on.
- Active My Context items and pinned facts.

**Sent to your speech-to-text provider:** audio, but only if you chose **Cloud provider** transcription.

**Nothing else.** No analytics, no tracking and no Runningbord account. The only other connection is the update check, which asks GitHub whether a new version exists.

**See exactly what was sent:** **Dashboard → Recent Requests** shows the last 25 requests: history, attachments, transcript, size and timing. API keys are never shown or logged.

---

## 11. Updates

Runningbord checks for new versions when it starts and every few hours. **It never installs anything on its own.** When an update is available:
- a blue dot appears on the ⚙ gear in the overlay, and a banner appears in the dashboard sidebar;
- go to **App Settings → Updates** and click **Install & restart** when it suits you.

Updates are signed, so the app only installs genuine releases from this project.

---

## 12. Troubleshooting

**The AI says my API key or model is wrong.**
Go to **Dashboard** and check the provider, key and model name. Model names must match your provider's exactly, for example `gpt-4o-mini`.

**Screenshots don't work (Mac).**
**App Settings → Permissions** → grant **Screen Recording**, then quit and reopen Runningbord. If it's already granted but still fails, remove Runningbord from the list in System Settings, add it back, and restart.

**Meeting mode is on but nothing is transcribed.**
- Make sure audio is actually playing through the computer (not only on a phone or external device).
- **App Settings → Permissions → System Audio Recording → Check** while audio plays.
- Make sure a transcription model is downloaded (**Meeting** page).
- Watch the live preview on the Meeting page to see what's being heard.

**Auto-answer didn't answer a question.**
- It only listens to other people, not your microphone.
- Check the live preview: if the question was transcribed without a question mark, it only counts when it starts with a question word ("what", "how", "can you", "tell me"…) and is at least five words long.
- It won't answer while you're typing in the overlay.

**Answers get cut off, or a long question is split in two.**
Increase the wait under **Answer questions automatically** to 3 or 5 seconds.

**The talk-time bar doesn't show.**
It needs Meeting mode, live transcription and **Also capture my microphone**, and appears once someone has spoken.

**Meeting notes weren't created.**
They need **Write notes when Meeting mode is turned off** switched on, live transcription, and a meeting of at least two minutes. You can always click **Generate now**.

**The overlay shows up in screen sharing.**
Some meeting apps capture the whole screen in ways that ignore the "hide from capture" setting. Share a single window or tab instead of the whole screen.

**Something else went wrong.**
**Dashboard → Recent Requests** shows the error for each recent request. If you report a problem on GitHub, include what you did and that error text (API keys aren't included).

---

## 13. Glossary

| Term | Meaning |
|---|---|
| **Overlay** | The small floating bar you type into. |
| **Dashboard** | The full window with settings and chats (**⌘⇧D**). |
| **AI provider** | The company whose AI answers your questions (OpenAI, Anthropic, Google…). |
| **API key** | A password-like code from your provider that lets Runningbord use your account. |
| **Model** | The specific AI version, such as `gpt-4o-mini` or `claude-haiku-4-5`. |
| **Meeting mode** | Runningbord listening to your computer's audio. |
| **Transcript** | The written text of what was said. |
| **Whisper** | The speech-recognition engine that runs on your computer. |
| **System prompt** | Instructions that set how the AI answers. |
| **My Context** | Background about you that the AI can draw on. |
| **Profile** | A saved set of settings for one kind of meeting. |
| **Pinned fact** | A fact every answer should treat as true. |
| **Auto-answer** | Answering others' questions without pressing anything. |
