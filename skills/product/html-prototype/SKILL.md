---
name: html-prototype
description: Build the prototype the user shows to a client — one self-contained HTML file that really works on made-up data — from an approved PRD. The same file is later given to engineers as the reference for the real app. Use right after the PRD is approved, and again for each change the user asks for.
---

# HTML Prototype — One Working File on Made-up Data

The user has approved a PRD. You build what they will put in front of the client: a single HTML file in which every step of their walkthrough really works, on made-up data. They try it, tick each acceptance line, ask for changes, and then show it. Afterwards engineers build the real application from the PRD and this file.

So the file has two readers: a client who must believe it, and an engineer who must understand it.

This skill can be replaced by the Hallmark skill without changing the flow. The contract is: an approved PRD in, one HTML file out.

---

## 1. What it is, and is not

- **It works.** If a step says the user adds a task, typing a name and pressing the button adds that task. Every acceptance line under *Must have for the demo* must be true when someone tries it.
- **It runs on made-up data held in the page.** Nothing is saved anywhere. Reloading the page puts it back to the start, and that is expected.
- **It is not the real application.** No real sign-in, no real systems, no real data. Where the PRD's *Real or pretend* table says something is pretend, imitate it convincingly: a short delay, a "Sent" message, a sample result.
- **It shows only what is in the PRD.** Nothing from *Later* or *Not doing*, and no extra screens, menus or settings for completeness.

## 2. Hard rules for the file

The app shows your file in a locked frame with no access to the network or to storage. Anything outside these rules will not work there.

- **One file.** One `<style>` in the `<head>` and one `<script>` at the end of the `<body>`. Plain JavaScript, no libraries, no modules.
- **Nothing from outside.** No links to stylesheets, scripts, fonts or images; no `url(...)` in CSS except `data:`. Use the system font stack. Icons are inline SVG or plain text.
- **No network and no storage.** Never `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `sessionStorage`, `indexedDB`, cookies, or `window.open`. They are blocked, and calling them breaks the page. Keep everything in JavaScript variables.
- **No form submission or page navigation.** Handle clicks and the Enter key in script and call `preventDefault()`. Screens are parts of the same page that you show and hide.
- **Must not break.** No uncaught errors on any path through the walkthrough, including empty input, deleting the last item, and going back.

## 3. Written so an engineer can read it

- **The data first.** Start the script with the made-up records as plain constants (`const ORDERS = [...]`), then the state, then small named functions. No clever tricks.
- **Mark each screen with its step.** The element holding a screen carries `data-step="S1"` (or `"S1 S2"` when steps share a screen).
- **Mark what is pretend.** Put `// PRETEND: <what the real app must do instead>` above any imitation, so the engineer sees every gap.
- **Design decisions as variables.** Colours, spacing, radius and font sizes go in `:root` as CSS custom properties with plain names (`--color-surface`, `--space-md`), and the rest of the CSS uses only those.
- **Keep it under about 700 lines.**

## 4. What makes the client believe it

- **Realistic made-up data, the same on every screen.** A order that is "ORD-2041, Rina Hartono, Under review" in the list is that on its detail screen. Enough rows to look real (the PRD often says how many). Never real people, clients or customers, and no lorem ipsum.
- **Wording from the PRD.** Button labels, messages and column names exactly as the acceptance criteria give them, in the PRD's language.
- **Every state the PRD names.** The empty list, the error message, the "done" look: each must be reachable by using the page.
- **One main action per screen**, visually the strongest thing on it.
- **Calm and legible.** Light background unless the PRD's branding says otherwise, strong text contrast, generous spacing, one accent colour, no decorative shadows or gradients.
- **Works narrow and wide.** It is tried in a panel about 600 pixels wide and shown to the client full screen.

## 5. When the user asks for a change

You receive the current file and their requests. Change what they asked for and nothing else, keep everything they did not mention working exactly as before, and send the whole file again. If a request is outside the PRD (a new screen, a new feature), do not build it: say in your message that it is outside the approved PRD and belongs in the notes for the real build.

## 6. What you send back

A short message to the user in plain language (two or three sentences: what is there and what to try first), then the file between a line containing only `<design>` and a line containing only `</design>`. Nothing after the closing tag. Never use technical words such as HTML, script or code in the message.
