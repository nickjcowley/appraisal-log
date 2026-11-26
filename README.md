# Appraisal Log

A private, single-user web app (PWA) for recording non-clinical (SPA) work as it happens, ready for the annual NHS appraisal on Allocate and for job planning. It's a sister app to PeopleLog and uses the same stack: plain HTML, CSS and JavaScript with no build step, GitHub Pages, Firebase Google sign-in, Firestore with offline persistence, and Gemini.

## Using it

- **✎ New entry:** dictate or type what you did (Wispr Flow works well). Gemini suggests the date, approximate hours, BMA activity code, role/project tags and a tidy title. You check each suggestion on the review screen, and nothing is saved until you press Save. *Enter manually* skips the AI step.
- **Home:** entries for the appraisal year you choose, with hours by code, search and filters. Tap an entry to edit it, add a reflection or link evidence (a OneDrive path or URL).
- **📊 Report:**
  - hours and PAs per week by activity code
  - role tags against your job-planned PAs
  - a year-on-year comparison
  - AI-drafted summaries per section, which you can edit, copy into Allocate or include in the PDF
  - **Download PDF** creates the supporting document.
- **Appraisal years** run from one appraisal date to the next. Add the next date in Settings once it's booked.
- The home-screen shortcut **New entry** (long-press the icon on Android) opens straight into capture.

### Codes and tags

| Code | Activity |
|---|---|
| S1 | Training |
| S2 | Continuing Professional Development |
| S3 | Teaching |
| S4 | Audit / Clinical Governance |
| S5 | Job Planning / Appraisal |
| S6 | Research |
| S7 | Clinical management |
| S8 | General administration |
| A2 | Audit or governance lead |
| D4 | Work for Royal Colleges |
| D5 | Other duties |
| CX | Clinical / extra sessions (not counted as SPA) |

These follow the BMA consultant job-planning diary used in the old spreadsheets. The default role tags are:

- ICU EPR lead / ICCA
- ICU governance lead
- RCoA HALO – sedation
- RCoA HALO – research management
- Research
- AI / digital projects
- Medico-legal
- Teaching & admissions interviews
- Appraisal & revalidation

You can rename, add or archive tags in Settings. An entry can carry several tags, and it counts towards each tag's total.

### What the hours mean

The log is for specific roles and blocks of protected time, not a full timesheet. Email, ad-hoc queries and short unscheduled tasks are mostly not itemised, so logged hours are a minimum, and the report and PDF say so.

In **Settings → Job plan** you set your non-clinical job plan items. The defaults are:
- ICU forum: 0.2857 PA/week, matched by "ICU forum" in the title
- Digital lead: 1.5 PAs, matched by the EPR/ICCA and AI tags
- Core SPA: 2 PAs, matched by the appraisal, teaching, HALO and research tags, plus any untagged entry

Each entry counts once, towards the first item it matches. Tagged entries that match no item (e.g. governance, medico-legal) are shown as "Not in job plan". Each item can have a rough estimate of unlogged hours per week, shown in its own column and never mixed into logged hours. Estimates only count from the date you set (default 1 July 2026, when the full weekly diary stopped), so earlier years aren't inflated.

### Information governance

Text sent for suggestions or summaries goes to Google Gemini, so never include patient-identifiable information. The app warns you before sending anything that looks like an NHS number, hospital number, date of birth, titled name or bed number. Use a Gemini key from a project **with billing enabled**, because on the paid tier Google doesn't use your content to improve its products.

## Data model

Everything is stored under `users/{uid}/…`:

- `entries/{id}` holds `date` (YYYY-MM-DD), `hours`, `code`, `tags` (a map of tagId → true), `title`, `text` and `reflection`. It also holds `evidence` (a map of id → `{label, path}`), `source` (`app` or `import`), `importRef`, `origCode`, `createdAt` and `updatedAt`.
- `config/settings` holds `geminiApiKey`, `geminiModel`, `appraisalDates` (a map of id → `{date}`), `jobPlan` (`{totalPAs, spaPAs, weeksPerYear, roles: {tagId: PAs}}`), `tags` (a map of id → `{name, order, archived}`), `reportName` and `evidenceBase`.
- `reports/{periodKey}` holds `sections` (a map of section key → summary text).

PAs are calculated as hours ÷ 4 ÷ working weeks, where working weeks are the period's weeks × (working weeks per year ÷ 52).

## One-off setup

1. **Firebase:** create a new project at <https://console.firebase.google.com>; Google Analytics isn't needed.
2. In **Build → Authentication → Get started → Sign-in method**, enable **Google**.
3. In **Authentication → Settings → Authorised domains**, add `nickjcowley.github.io`.
4. In **Build → Firestore Database → Create database**, choose the London (`europe-west2`) location and production mode. Then open **Rules**, paste in `firestore.rules` and click **Publish**.
5. In **Project settings → General → Your apps**, add a **Web app** (no hosting) and copy its `firebaseConfig`. Paste it into `firebase-config.js` in this repo; you can edit the file directly on GitHub.
6. In **Google Cloud console → APIs & Services → Credentials**, restrict the Firebase *Browser key* to the HTTP referrers `https://nickjcowley.github.io/*` and `https://<project-id>.firebaseapp.com/*`.
7. **GitHub → Settings → Pages:** deploy from the `main` branch, root folder.
8. Open the site, sign in, then go to **Settings**:
   - paste your Gemini key (you can reuse the PeopleLog key)
   - check the job plan figures
   - import `appraisal-history-import.json`
9. On Android, open the site in Chrome and choose **Install app**. On a laptop, use Chrome or Edge and click the install icon in the address bar.

## Historical import

`appraisal-history-import.json` is built from the cell comments in the weekly sheets of the `NickCowleyWorkDiary` workbooks, Nov 2018 – Aug 2026.

- **Hours** come from the coded half-hour blocks around each comment.
- **Codes:** the drifting labels are mapped to the codes above. The old "IT work" code (S9) becomes S7 with the EPR tag, and c-codes and p3 become CX.
- **Tags** are suggested from keywords.
- **Appraisal dates** are taken from the diary's appraisal-meeting entries.

**The import file contains colleague names and governance detail, so it is not kept in this public repo.** Keep it in OneDrive. Re-importing the file skips entries already imported, unless you tick *Overwrite*.

## Releases

For every release, bump `CACHE_NAME` in `sw.js` and the `?v=` numbers on `styles.css`, `app.js` and `firebase-config.js`. These appear in `index.html`, `sw.js` and the `app.js` import line. Also update `APP_VERSION` in `app.js`.

## Privacy

This is single-user and private, and each signed-in user can only read and write their own `users/{uid}` subtree. **Sign out** also clears the offline copy from the device.
