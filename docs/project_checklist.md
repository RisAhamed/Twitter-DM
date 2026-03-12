# Twitter DM Automation — Project Checklist

> **Last Updated:** 2026-03-12
> **Status:** � Core Build Complete — Ready for Testing

---

## Phase 1: Project Setup
- [x] Create directory structure (`data/`, `logs/`, `prompts/`, `docs/`)
- [x] Create agent configuration (`.github/agents/twitter-dm-overseer.agent.md`)
- [x] Create `project_checklist.md`
- [ ] Initialize `package.json` with `npm init`
- [ ] Install dependencies: `puppeteer`, `csv-parser`, `groq-sdk` (or `node-fetch` for API calls)
- [ ] Create `.env` file for secrets (`GROQ_API_KEY`, cookie values)
- [ ] Add `.gitignore` (exclude `.env`, `node_modules/`, cookies)

## Phase 2: Data Pipeline
- [ ] Create `data/leads.csv` with sample HVAC leads
- [ ] Build CSV reader module (`src/readLeads.js`)
- [ ] Build deduplication logic — cross-reference `leads.csv` against `logs/dm_metrics.csv`
- [ ] Unit test: verify duplicate leads are skipped correctly

## Phase 3: AI Message Generation
- [ ] Write `prompts/hvac_pitch.txt` system prompt
- [ ] Build Groq API integration module (`src/generateMessage.js`)
- [ ] Validate messages are personalized (not generic) using `Name` + `Bio`
- [ ] Handle Groq API errors gracefully (rate limits, timeouts, bad responses)
- [ ] Unit test: verify personalized output for sample leads

## Phase 4: Puppeteer DM Sending
- [ ] Build Puppeteer launcher with cookie injection (`src/sendDM.js`)
- [ ] Implement Twitter DM navigation and message input flow
- [ ] Implement strict rate limiting (~28 min sleep between sends, ~50 DMs/day cap)
- [ ] Handle edge cases: user not found, DMs blocked, page load failures
- [ ] Verify message delivery via UI state checks

## Phase 5: Logging & Metrics
- [ ] Build logger module (`src/logger.js`)
- [ ] Log every attempt to `logs/dm_metrics.csv` with: `Timestamp`, `Username`, `Status`, `Error_Reason`, `Generated_Message`
- [ ] Ensure "Failed" entries are retryable without resending to "Sent" contacts
- [ ] Create daily summary output in console after each run

## Phase 6: Main Orchestrator
- [ ] Build `index.js` — main entry point tying all modules together
- [ ] Flow: Read leads → Deduplicate → Generate message → Send DM → Log result → Sleep → Repeat
- [ ] Add graceful shutdown handling (Ctrl+C saves state)
- [ ] Add CLI flag or env var for dry-run mode (generate messages but don't send)

## Phase 7: Testing & Hardening
- [ ] End-to-end test with 2-3 real leads
- [ ] Verify deduplication across multiple runs
- [ ] Verify rate limiting holds under extended runs
- [ ] Stress test error handling (simulate Puppeteer crash, Groq timeout)
- [ ] Review all logs for data integrity

---

## Known Bugs
_None yet._

## Daily Execution Metrics

| Date | Leads Processed | Sent | Failed | Skipped (Dup) | Notes |
|------|-----------------|------|--------|----------------|-------|
| — | — | — | — | — | Project not yet running |
