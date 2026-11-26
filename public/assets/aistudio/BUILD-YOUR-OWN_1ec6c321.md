# Build Your Own Outreach Desk

This is a guide to building a small, private cold-email system. It finds leads on a schedule, turns them into a CSV, sends the emails from several mailboxes at a safe pace, and tracks everyone on a pipeline board until they reply, book a call or drop off.

It explains the flow and the decisions behind it. It doesn't include my code, credentials, mailboxes or domains, so you'll build your own version. The architecture works whatever stack you pick.

---

## 1. The flow

```
 ┌────────────────────┐   weekly    ┌───────────────┐   import   ┌──────────────────────┐
 │ AI research agent  │ ──────────▶ │  leads.csv    │ ─────────▶ │  Outreach dashboard  │
 │ (Claude / ChatGPT  │             │ (one row per  │            │  pick mailbox → send │
 │  scheduled task)   │             │  person, with │            └──────────┬───────────┘
 └────────────────────┘             │  the email    │                       │ batches
          ▲                         │  already      │                       ▼
          │                         │  written)     │            ┌──────────────────────┐
          │                         └───────────────┘            │  SMTP (your mail     │
          │                                                      │  provider)           │
          │   "no reply after N days"                            └──────────┬───────────┘
          │   list → follow-up CSV                                          │
          └───────────────────────────────── pipeline board ◀──── replies land in the
                                             (you move cards)      reply-to inbox
```

1. **Find leads.** A scheduled AI task researches businesses that match your offer and writes a personalised first email for each one. It gives you a CSV.
2. **Import.** You drop the CSV into the dashboard, check the preview and pick which mailbox (which brand) it goes out from.
3. **Send.** The server sends the emails in small, spaced-out batches and stops at a daily limit for each mailbox.
4. **Track.** Every recipient becomes a card on a Kanban board. Replies go to that brand's reply-to inbox, and you move the card yourself.
5. **Follow up.** For anyone who hasn't replied after a few days, a second AI prompt writes short follow-ups, which you import or send from the lead's page.

---

## 2. Stack

| Part | What I used | Why |
| --- | --- | --- |
| Frontend | React + Vite + Tailwind | Fast to build. Hosted as a static site (Netlify, Vercel or Cloudflare Pages all work). |
| Backend | Node + Express, deployed as a serverless function | Small API and cheap hosting. |
| Email | Nodemailer over SMTP | Works with any mailbox provider (Zoho, Google Workspace, Microsoft 365 and others). No third-party sending service needed. |
| Database | MongoDB (Atlas free tier) | Serverless functions keep nothing between requests, so you need a hosted database. Postgres (Neon or Supabase) works just as well. |
| Drag and drop | dnd-kit | Unlike native HTML drag and drop, it works with touch on phones. |
| CSV parsing | PapaParse, in the browser | The browser parses the file, so the server only receives clean JSON. |

The frontend and the API are separate deployments on separate subdomains, and the API only accepts requests from the frontend's origin (CORS).

---

## 3. Data model

You only need three collections or tables.

**Lead** (one per email address, unique)
- `email`, `name`, `firstName`, `company`, `title`, `website`, `tags`
- `status`: `new → contacted → replied → interested → meeting → won / lost / invalid`
- `emailCount`, `lastContactedAt`, `lastSenderId`
- `notes`, plus a `fields` object holding any extra CSV columns
- `history[]`: `{status, at, note}` for the timeline

**Campaign** (one per CSV import)
- `name`, `senderId`, `status` (`draft / sending / paused / completed`), timestamps

**Message** (one per email)
- `lead`, `campaign` (or none for one-off emails), `senderId`, `to`, `subject`, `html`, `text`
- `status`: `queued → sending → sent / failed`
- `error`, `attempts`, `messageId` (keep it, because threading needs it), `sentAt`

Work out campaign totals from the messages each time you need them, instead of storing counters. Stored counters drift out of step with the real numbers.

---

## 4. Sending: the part that matters most

**You don't need a queue service, but don't send everything at once either.** Mail providers flag sudden bursts, and serverless functions have time limits. This approach works:

1. Importing a CSV creates a `queued` Message for every row. Nothing is sent yet.
2. The dashboard calls `POST /campaigns/:id/send-batch` again and again.
3. Each call **claims** the next queued message atomically (a single update from `queued` to `sending`, so two calls can't send the same email), sends it, waits a moment, and repeats a handful of times before returning progress.
4. The browser keeps calling until nothing is left, until you press pause, or until the mailbox reaches its daily limit.
5. Messages stuck in `sending` for more than a few minutes (because a function died partway through) go back to `queued`.

Starting numbers: **about 8 emails per call, 1 to 2 seconds apart, and a daily limit per mailbox of a few hundred at most.** Start lower on a new domain and increase slowly.

Other details that matter:

- **Several brands, one person.** Each mailbox has its own config: sender name, from address, SMTP login and **reply-to address**. That lets you send as the founder from a personal-looking address while replies go to a shared inbox. Keep this config in environment variables (`SENDER_1_*`, `SENDER_2_*`…) and never send SMTP passwords to the browser.
- **App passwords.** Most providers want an app-specific password for SMTP, not your login password.
- **Bounces.** If SMTP rejects the address outright (550, 551, 553 "mailbox doesn't exist" and similar), mark the lead `invalid` and skip it in every future import.
- **Plain text plus simple HTML.** Send both parts. Keep the HTML minimal so it looks typed rather than designed, with no images, no tracking pixels and no heavy templates.
- **Add a `List-Unsubscribe` header** (`mailto:` your reply-to address). Inbox providers reward it.
- **Threaded follow-ups.** When you send a follow-up, set `In-Reply-To` and `References` to the `messageId` of the previous email, and use `Re: <original subject>`. It then shows up in the same conversation in their inbox.
- **Placeholders.** Replace `{{first_name}}`, `{{company}}` or any other column name when the CSV is imported, and replace unknown placeholders with an empty string.
- **Duplicates.** Before importing, look up which emails are already in the database. Show "already emailed N times" in the preview, and default to skipping those people.

---

## 5. Access and privacy

It's a personal tool, so there are no user accounts. It uses a single access code.

- The code lives in a server environment variable. The login screen asks for it like an OTP prompt, and the server returns a signed token that lasts about 30 days.
- Mix the code into the token-signing key so that **changing the code logs out every device**.
- Rate-limit wrong guesses by IP, and **store the failed attempts in the database**. Memory doesn't survive serverless cold starts.
- Keep it out of search engines in every way you can: a `robots.txt` that disallows everything, `noindex` meta tags, an `X-Robots-Tag: noindex` header on both the site and the API, no sitemap, and no links to it from anywhere.

---

## 6. Screens

- **Overview:** total leads, emails sent, engaged and reply rate, a 14-day send chart, a pipeline breakdown, each mailbox's daily capacity and the latest sends.
- **Import:** drag and drop a CSV, a validation preview (invalid, duplicate or already emailed), a click-to-preview of each email, a mailbox picker that shows the reply-to address, and *Import & send* or *Import only*.
- **Campaigns:** a progress ring, start / pause / resume, retry failed sends, a list of messages with filters.
- **Pipeline:** a Kanban board with one column per status, plus a list view. Clicking a card opens a drawer with the stage, notes, every email sent to them, the timeline and a **Follow up** composer.
- **Outbox:** every email, filterable by status and mailbox.
- **Settings:** each mailbox with a **Test connection** button, the CSV format and a template download.

Put the send loop at the app level, not inside a single page, so it keeps running while you browse. Show a small progress pill in the corner.

Make it work on a phone: a bottom tab bar, a board you swipe sideways with columns that snap into place, and drawers that open as bottom sheets.

---

## 7. CSV format

Required columns: `email`, `subject`, `body`
Optional columns: `first_name`, `last_name`, `name`, `company`, `title`, `website`, `phone`, `tags` (separated by `;`), plus any extra column you want to use as a `{{placeholder}}`.

```csv
email,first_name,company,title,website,tags,subject,body
ada@example.com,Ada,Example Logistics,COO,https://example.com,logistics;lagos,"Quick idea for {{company}}","Hi {{first_name}},

<one line showing you looked at their business>

<one line on the problem you solve>

<one easy ask>

Best,
<your name>"
```

A blank line in the body starts a new paragraph. Bodies can also be HTML. Map common header variations (`Email Address`, `Subject Line`, `Message`…) to the standard names when you parse the file.

---

## 8. Lead-finding prompt (run on a schedule)

Run this as a recurring task:

- **Claude:** create a scheduled task (in the Claude app or Claude Code), for example every Monday at 8am. Turn on web search.
- **ChatGPT:** use **Tasks** (schedule) with web search or deep research turned on.

Ask it to give you the CSV as a file or in a code block, then save it and import it.

Fill in everything in `<angle brackets>` once. That's your targeting.

```text
You are my B2B lead researcher and cold-email writer. Run this every week.

ABOUT ME
- Sender name: <your name>, <your role> at <company>
- What we do: <one sentence: the problem you solve and for whom>
- Proof: <1–2 real results, numbers or client types; never invent any>
- Call to action: <e.g. "open to a 15-minute call next week?">

WHO TO FIND
- Industry / niche: <e.g. mid-size logistics companies>
- Location: <cities / countries>
- Size: <e.g. 10–200 staff, or revenue band>
- Signals that they need us now: <e.g. hiring for X, just raised, new branch,
  outdated website, no online ordering, recent press about Y>
- Who to contact: <roles, e.g. founder, COO, head of operations>
- Exclude: <competitors, existing clients, domains to skip>

RULES
1. Use web search. Only include people or businesses you actually found on a
   public page (company website, team page, press, public directory or
   professional profile). Record that page's URL in `source_url`.
2. Emails: prefer an address published on the company's own site. If you
   have to infer one from the company's visible email pattern, set
   `email_confidence` to "inferred". Otherwise use "published". Never make up
   people, companies, numbers or quotes. If unsure, leave the row out.
3. Business contact details only. No personal phone numbers, home addresses
   or anything sensitive.
4. Find <N, e.g. 25> new leads. Skip anyone in this list of emails I've
   already contacted: <paste or attach list, or "none">.
5. For each lead, write ONE first-touch email:
   - Subject: under 7 words, lowercase-friendly, no clickbait, no emojis.
   - Body: under 90 words, plain text, no links unless essential.
     Line 1: something specific you found about THEM (the signal).
     Line 2: the problem it suggests plus what we do, in one sentence.
     Line 3: one piece of proof (only from "Proof" above).
     Line 4: the call to action as a soft question.
     Sign-off: "<your first name>".
   - Sound like a busy founder typing, not marketing. Avoid "I hope this
     email finds you well", "synergy", "revolutionize", "quick question?".
   - Use {{first_name}} in the greeting.

OUTPUT
Return ONLY a CSV (UTF-8, comma-separated, every field in double quotes,
real line breaks inside the body) with exactly these columns:

email,first_name,last_name,company,title,website,tags,email_confidence,source_url,signal,subject,body

Then, below the CSV, a short list of the leads you rejected and why
(e.g. "no contact email found").
```

**Before importing:** spot-check a few `source_url`s, delete or verify the `inferred` rows (run them through an email verifier if you have one), and read every email in the dashboard's preview. The AI drafts and you approve.

---

## 9. Follow-ups

Most replies come from the 2nd or 3rd touch. Keep the sequence short:

| Touch | When | What |
| --- | --- | --- |
| 1 | Day 0 | The first-touch email from the CSV |
| 2 | Day 3–4 | A 2-line bump in the same thread, adding one new angle or proof point |
| 3 | Day 7–9 | A useful resource or idea, still in the same thread |
| 4 | Day 14 | A polite close: "Should I close the loop on this?" |

Stop the sequence as soon as someone moves to `replied` or further along the pipeline, or `invalid`.

**Two ways to send them:**

1. **One at a time (built in).** Open the lead and click **Follow up**. The composer fills in `Re: <last subject>`, threads the email under the last one and sends it immediately.
2. **In bulk (recommended extension).** Add an endpoint that lists leads with `status = contacted`, `lastContactedAt` older than N days and `emailCount < 4`. Export them as a CSV with each one's last subject and body, run the prompt below, and import the result as a new campaign. Make the importer thread each follow-up under that lead's previous `messageId` when the subject starts with `Re:`.

You can also run the follow-up prompt on a schedule if you attach or paste the export.

```text
You write follow-up emails for my cold outreach. Here is a CSV of people who
haven't replied. Columns: email, first_name, company, touch_number,
last_subject, last_body, signal.

For each row, write the NEXT email in the thread:
- touch_number 1 → write touch 2: a 2-line bump. Reference the last email
  in a few words, add ONE new angle or proof point, and repeat the ask
  more softly. Under 50 words.
- touch_number 2 → write touch 3: share one genuinely useful idea or
  observation specific to their business (based on `signal`). No pitch
  beyond one line. Under 70 words.
- touch_number 3 → write touch 4: a polite close-the-loop email. Give them an easy
  way to say "not now". Under 40 words.
- touch_number 4 or more → skip the row.

Rules: subject must be "Re: " + last_subject exactly. Plain text, no links,
no guilt-tripping ("just bumping this to the top of your inbox"), no
fake urgency. Use {{first_name}}. Sign off "<your first name>".

Proof I'm allowed to use: <same proof list as the lead prompt>

Return ONLY a CSV with columns: email,first_name,company,subject,body
```

---

## 10. Deliverability and compliance checklist

- [ ] Set up **SPF, DKIM and DMARC** on every sending domain (your mail provider's admin panel walks you through it).
- [ ] Consider a **separate domain** for cold outreach so your main domain's reputation stays safe.
- [ ] **Warm up** new mailboxes: about 10–20 a day at first, increasing over 2–4 weeks.
- [ ] Use real inboxes that real people reply from. Never use no-reply addresses.
- [ ] Use a **suppression list**: anyone who replies "stop" or "unsubscribe" gets marked `lost` and is never emailed again. The importer already skips `invalid` leads, so add opted-out leads to that check.
- [ ] Follow the rules where your recipients are, for example CAN-SPAM (US), GDPR / PECR (UK and EU), NDPR (Nigeria). In general that means contacting businesses about something relevant to their role, identifying yourself honestly, giving them an easy way to opt out and honouring it, and keeping only the data you need.
- [ ] Watch your bounce rate. Above about 3%, stop and clean the list.

---

## 11. Building it with an AI coding agent

If you build it with Claude Code, Codex, Cursor or a similar tool, paste this as the brief, then go through it one section at a time.

```text
Build a private outreach dashboard as two apps in one folder:
/client (React + Vite + Tailwind, static hosting) and /server (Express,
deployable as a serverless function, MongoDB via Mongoose, Nodemailer SMTP).

- Auth: a single access code from env; an OTP-style entry screen; return a
  signed 30-day token. The signing key includes the code so changing the
  code logs out every device. Store failed attempts in the DB and rate-limit
  them by IP.
- Senders: numbered env groups SENDER_n_{ID,LABEL,NAME,EMAIL,REPLY_TO,PASS,
  HOST,PORT,DAILY_LIMIT}. Never expose passwords to the client. Add a
  "test connection" endpoint for each sender.
- Models: Lead (unique email, status pipeline, emailCount, lastContactedAt,
  history), Campaign, Message (queued/sending/sent/failed, messageId).
- CSV import: parse in the browser, normalise headers, preview with
  validation and "already emailed" lookup, choose sender, then queue
  messages (render {{placeholders}} at import time).
- Sending: a client-driven batch loop. Each request atomically claims and
  sends ~8 queued messages, 1.5s apart, respecting each sender's daily
  limit, then returns progress. Requeue stale "sending" rows. Mark leads
  invalid on permanent 55x recipient errors. Add a List-Unsubscribe header.
- Follow-ups: send now from a lead's page, threaded via In-Reply-To/References.
- UI: Overview, Import, Campaigns (start/pause/retry), Kanban pipeline
  (dnd-kit, touch support) with a lead drawer, Outbox, Settings. Must work on
  phones.
- Hide it from search engines: robots.txt disallowing everything,
  noindex meta tags, and an X-Robots-Tag header on both apps.
```

Test it before sending anything real. Run a throwaway local MongoDB and a fake SMTP server (for example the `smtp-server` npm package), then import a CSV that includes a bounce address and check the headers on the emails it delivers.
