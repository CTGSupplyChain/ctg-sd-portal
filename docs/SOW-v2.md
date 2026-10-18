# Supply Chain Portal — SOW v2 (18 Oct 2026)

Full SOW: Claude doc "Supply Chain Portal — SOW v2" (owner: SimpleJack).

| Phase | Scope | Status (18 Oct) |
|---|---|---|
| 0 — Consolidate | Git = production, migrations in repo, write functions locked down, calendar, data refresh | Done except: backfill of pre-18-Oct migrations into repo; RADAR token |
| 1 — Two views | CTG Supply Chain (superadmin/admin/buyer) and Brand owner (read-only, own brand) | Done in DB + UI; test users to be created |
| 2a — Inventory health | `/dashboard`, SKU-level WOC / run-out / bands | Live; now open to brand owners |
| 2b — Inventory parameters | `/inventory-params` over `v_inventory_params` | Live |
| 3 — Accuracy + onboarding | Weekly attach-rate log, WMAPE/bias, other brands | Next |
| 4 — BOM explosion | Kits → component demand → planned PO | Next |
| 5 — PO release list | Suggested POs for the buyer to review, edit and release (from inventory parameters) | Next (design agreed 18 Oct) |
| Backlog | Supplier / PO approval workflow | Not scheduled |
| After all phases | Connect to the Procurement portal (owned by another colleague) so PO quantity and ETA populate automatically; retires manual entry in the Supply (Commit) row | Not started — do last |

Data on 18 Oct: sales_history through week of 21 Sep 2026; stock = Packxpert inventory report 18 Oct 2026;
iLady demand_forecast regenerated from the 7 Jul 2026 submission (needs a new forecast).

Open PO entry (18 Oct): superadmin/admin type quantity in the Supply (Commit) row of the S&D grid; stored as OPEN-<sku>-<week> lines in purchase_orders. Temporary until the Procurement portal connection.
