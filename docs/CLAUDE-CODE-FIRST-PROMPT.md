# First prompt for Claude Code

Paste this as the first message in Claude Code, opened in the repo root:

---

You are taking over the CTG Supply Chain Portal from a Claude app session. I'm SimpleJack (JiaJie Ong), the owner; I work as a contractor on this and I want you to run it end to end.

Before doing anything:
1. Read `CLAUDE.md`, `docs/HANDOVER.md` and `docs/SOW-v2.md` in full. They contain the environments, roles, domain rules, data state, workflow, open items and decisions. Treat the repo and the live database as the source of truth; if they disagree with the docs, tell me and fix the docs.
2. Confirm your tool access and report each as OK/missing, without printing any secret: git push to `CTGSupplyChain/ctg-sd-portal`, `gh`, Vercel (team `ctg-supply-chain-s-projects`, project `ctg-sd-portal`), Supabase project `cnmpbitgyezrgfgwqbuh` only (never write to the retired `cxmpkvwpdmheddquixjw` or supplychain-portal.vercel.app), and a Chrome/browser tool for checking live pages.
3. Run `git status`, `npx tsc --noEmit`, and check that https://ctg-sd-portal.vercel.app loads and the latest production deployment is READY and matches `main`.
4. Query Supabase read-only to confirm: the 8 accounts in `profiles`, `v_inventory_params` row counts for iLady/SkinDae/Kata, `purchase_orders` all Cancelled with the archive table intact, and `master_sku.hidden_at` empty.

Then give me a short status (what is verified, what is missing or inconsistent) and propose the plan for the next SOW phase. The order is Phase 3 (weekly attach-rate accuracy log with WMAPE/bias, then onboarding other brands), Phase 4 (BOM explosion to planned PO), and last the Procurement-portal connection. Also list the small cleanup items (backfill pre-18-Oct migrations into the repo, drop `_sh_stage`, remove the superseded `20261018_inventory_params.sql`).

How I want you to work:
- One phase at a time. Branch from `main`, commit, push, give me the Vercel preview URL, and wait for my explicit "merge" before merging to `main`.
- Every schema change is a file in `supabase/migrations`; back up before any migration that alters or deletes data; run the Supabase security advisors after DDL (no new ERROR findings).
- After every production deploy, open the live page in Chrome and confirm the change renders, check the console, then report.
- Never print or commit secrets, never type passwords (ask me to sign in), no hard deletes of data (archive/cancel instead), free tiers only.
- Be professional and concise, no small talk, and don't relate your answers to my other work. Ask me only when you are blocked or a decision is irreversible; otherwise make the call and say what you chose.

Things I still owe you: the new iLady forecast, iLady open PO data, a new `RADAR_PULL_TOKEN` (the `wms-stock-pull-5min` cron is paused until then), real MOQs and lead times for Kata, and sign-in tests of the owner_ilady / admin_ilady / buyer_ilady accounts.
