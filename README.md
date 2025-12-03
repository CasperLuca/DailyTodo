# DailyTodo

A helper plugin that manages repeating and completed todo's on a daily basis


# RemNote Daily Todo Rollover (unlisted / personal)

A small plugin for RemNote that automates daily task management:

- Each morning (or on manual command) it copies your tasks from **Repeating** > **Today**, turning them into todos  
- Moves completed todos from **Today** > **Completed**, converting them into plain rems, with duplicate prevention  

> This plugin is intended for **my personal use only** (unlisted). Use at your own risk.

---

## Assumptions & Requirements

For the plugin to work properly, your RemNote database must include exactly this structure of rems (names are case-sensitive):

> - Notepad
>   - Todo
>   - Today
>   - Repeating
>   - Completed

- Under `Todo`, there are direct child rems named `Today`, `Repeating`, and `Completed`.  
- Under `Repeating`, only plain rems represent tasks - avoid heading-style children (to prevent unwanted "Size" rems).  

If any of these are missing or renamed, the plugin will abort and log an error in the console.

##  Installation & Use (Local)

1. Clone this repository (or download as ZIP).  
2. Run `npm install`.  
3. Build the plugin with:  
   ```bash
   npm run dev
4. connect to remnote: settings > plugin > build > develop from local host

5. Use the command **“Daily Todo Rollover: run now”** from the Omnibar or enable the auto-rollover setting (defaults to 07:00 local time).

---

## Usage

- **Manual run**: open Omnibar (Ctrl+P), type `Daily Todo Rollover: run now`, hit enter.  
- **Automatic daily rollover**: leave plugin enabled; by default it triggers after 07:00 — you can adjust hour / minute in Settings.  

**What it does**:

- Today (finished todos) : Moved to Completed (plain rem, newest at top)
- Repeating moved to Today : Created as new unfinished todos (if not already present) |

---

## Known Limitations & What to Watch Out For

- If you rename or delete any of the core rems (Notepad, Todo, Today, Repeating, Completed), the plugin will not work.  
- If you manually create non-todo or strangely structured children under Repeating, duplicates or unexpected rems may appear.  
- On API/runtime changes in RemNote — especially around rem ordering or list manipulation — the plugin behavior may break; no automated fallback or test suite is provided.  
- No backup — changes (move / delete) are immediate; use with care or keep a backup of your Important rems.

---

## License & Status

- License: MIT (or whatever you prefer — see LICENSE file)  
- Status: **Private / unlisted — personal project**  