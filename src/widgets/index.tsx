import {
  declareIndexPlugin,
  ReactRNPlugin,
} from "@remnote/plugin-sdk";

/* ---------- Settings & storage keys ---------- */

const SETTING_AUTO_ENABLED = "auto_roll_enabled";
const SETTING_AUTO_HOUR = "auto_roll_hour";
const SETTING_AUTO_MINUTE = "auto_roll_minute";

const STORAGE_LAST_RUN_DATE = "daily_todo_rollover_last_run";

/* ---------- Rem name constants ---------- */

const ROOT_NOTEBOOK_NAME = "Notepad";
const TODO_DOC_NAME = "Todo";
const TODAY_NAME = "Today";
const REPEATING_NAME = "Repeating";
const COMPLETED_NAME = "Completed";
const HEADING_STYLE_CHILD_NAME = "Size";

/* ---------- State ---------- */

let intervalId: number | undefined;

/* ---------- Helpers ---------- */

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${(now.getMonth() + 1)
    .toString()
    .padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
}

function normName(s: string | undefined | null) {
  return (s ?? "").trim();
}

async function richTextToString(
  plugin: ReactRNPlugin,
  text: any | undefined
): Promise<string> {
  if (!text) return "";
  return plugin.richText.toString(text);
}

/**
 * Find the Todo document that lives under a parent named ROOT_NOTEBOOK_NAME,
 * anywhere in the knowledge base.
 */
async function findTodoDocument(plugin: ReactRNPlugin) {
  const results = await plugin.search.search([TODO_DOC_NAME]);

  for (const rem of results) {
    const txt = normName(await richTextToString(plugin, rem.text));
    if (txt !== TODO_DOC_NAME) continue;

    let parent = await rem.getParentRem();
    while (parent) {
      const pText = normName(await richTextToString(plugin, parent.text));
      if (pText === ROOT_NOTEBOOK_NAME) {
        return { notepad: parent, todoDoc: rem };
      }
      parent = await parent.getParentRem();
    }
  }

  return { notepad: undefined, todoDoc: undefined };
}

async function getChildByName(
  plugin: ReactRNPlugin,
  parent: any,
  name: string
) {
  const children = await parent.getChildrenRem();
  for (const child of children) {
    const txt = normName(await richTextToString(plugin, child.text));
    if (txt === name) return child;
  }
  return undefined;
}

/**
 * Locate the Today / Repeating / Completed sections under the Todo doc.
 */
async function findTodoSections(plugin: ReactRNPlugin) {
  const { notepad, todoDoc } = await findTodoDocument(plugin);

  if (!notepad || !todoDoc) {
    return {
      notepad,
      todoDoc,
      today: undefined,
      repeating: undefined,
      completed: undefined,
    };
  }

  const today = await getChildByName(plugin, todoDoc, TODAY_NAME);
  const repeating = await getChildByName(plugin, todoDoc, REPEATING_NAME);
  const completed = await getChildByName(plugin, todoDoc, COMPLETED_NAME);

  console.log("[DailyTodo] Sections:", {
    today: !!today,
    repeating: !!repeating,
    completed: !!completed,
  });

  return { notepad, todoDoc, today, repeating, completed };
}

/* ---------- Core rollover logic ---------- */

/**
 * Main rollover:
 * 1) Archive finished todos from Today → Completed (dedup, newest on top)
 * 2) Copy Repeating → Today as unfinished todos (no duplicates, skip “Size”)
 */
async function runRollover(plugin: ReactRNPlugin) {
  console.log("[DailyTodo] Starting rollover…");

  const { notepad, todoDoc, today, repeating, completed } =
    await findTodoSections(plugin);

  if (!notepad || !todoDoc || !today || !repeating || !completed) {
    console.warn("[DailyTodo] Missing required structure; aborting.", {
      notepad: !!notepad,
      todoDoc: !!todoDoc,
      today: !!today,
      repeating: !!repeating,
      completed: !!completed,
    });
    return;
  }

  const mutate = async () => {
    /* --- 1) Archive finished todos from Today → Completed --- */

    const todayChildren = await today.getChildrenRem();
    type FinishedTodo = { rem: any; text: string };
    const finished: FinishedTodo[] = [];

    for (const child of todayChildren) {
      const isTodo = await child.isTodo();
      if (!isTodo) continue;

      const status = await child.getTodoStatus();
      if (status !== "Finished") continue;

      const plainText = normName(
        await richTextToString(plugin, child.text)
      );
      if (!plainText) continue;

      finished.push({ rem: child, text: plainText });
    }

    if (finished.length > 0) {
      console.log(
        "[DailyTodo] Finished todos to archive:",
        finished.map((f) => f.text)
      );
    }

    // Delete existing duplicates in Completed
    if (finished.length > 0) {
      const completedChildren = await completed.getChildrenRem();
      const toDelete = new Set<string>();

      for (const { text } of finished) {
        for (const c of completedChildren) {
          const cText = normName(
            await richTextToString(plugin, c.text)
          );
          if (!cText) continue;
          if (cText !== text) continue;
          toDelete.add(c._id);
        }
      }

      for (const c of completedChildren) {
        if (!toDelete.has(c._id)) continue;
        const anyRem = c as any;
        if (typeof anyRem.remove === "function") {
          await anyRem.remove();
        }
      }
    }

    // Move finished todos to top of Completed as plain rems
    for (const { rem, text } of finished) {
      await rem.setIsTodo(false);
      await rem.setIsListItem(false);
      // Your runtime supports position index as second argument
      await rem.setParent(completed, 0);
      console.log("[DailyTodo] Archived:", text);
    }

    /* --- 2) Rebuild set of existing unfinished todos in Today --- */

    const todayChildrenAfter = await today.getChildrenRem();
    const existingUnfinished = new Set<string>();

    for (const child of todayChildrenAfter) {
      const isTodo = await child.isTodo();
      if (!isTodo) continue;

      const status = await child.getTodoStatus();
      if (status !== "Unfinished") continue;

      const txt = normName(
        await richTextToString(plugin, child.text)
      );
      if (!txt) continue;

      existingUnfinished.add(txt);
    }

    /* --- 3) Copy Repeating → Today as new unfinished todos --- */

    const repeatingChildren = await repeating.getChildrenRem();

    for (const source of repeatingChildren) {
      const plainText = normName(
        await richTextToString(plugin, source.text)
      );

      if (!plainText) continue;
      if (plainText === HEADING_STYLE_CHILD_NAME) continue;

      if (existingUnfinished.has(plainText)) continue;

      if (await source.isTodo()) {
        await source.setIsTodo(false);
      }

      const newRem = await plugin.rem.createRem();
      if (!newRem) continue;

      await newRem.setParent(today);
      await newRem.setText([plainText]);
      await newRem.setIsTodo(true);
      await newRem.setTodoStatus("Unfinished");

      existingUnfinished.add(plainText);
    }
  };

  // Feature-detect transaction support
  const appAny = plugin.app as any;
  if (typeof appAny.transaction === "function") {
    await appAny.transaction(mutate);
  } else {
    await mutate();
  }

  console.log("[DailyTodo] Rollover completed.");
  await plugin.app.toast("Daily rollover done.");
}

/* ---------- Scheduled rollover ---------- */

async function maybeRunScheduledRollover(plugin: ReactRNPlugin) {
  const enabled =
    await plugin.settings.getSetting<boolean>(SETTING_AUTO_ENABLED);
  if (!enabled) return;

  const hour =
    (await plugin.settings.getSetting<number>(SETTING_AUTO_HOUR)) ?? 7;
  const minute =
    (await plugin.settings.getSetting<number>(SETTING_AUTO_MINUTE)) ?? 0;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const targetMinutes = hour * 60 + minute;

  const lastRun = await plugin.storage.getLocal<string>(STORAGE_LAST_RUN_DATE);
  const today = todayKey();

  if (lastRun === today) return;
  if (nowMinutes < targetMinutes) return;

  try {
    console.log("[DailyTodo] Auto rollover triggered.");
    await runRollover(plugin);
    await plugin.storage.setLocal(STORAGE_LAST_RUN_DATE, today);
  } catch (e) {
    console.error("[DailyTodo] Auto rollover error:", e);
  }
}

/* ---------- Plugin lifecycle ---------- */

async function onActivate(plugin: ReactRNPlugin) {
  console.log("[DailyTodo] Plugin activated.");

  await plugin.settings.registerBooleanSetting({
    id: SETTING_AUTO_ENABLED,
    title: "Enable daily auto-rollover",
    defaultValue: true,
  });

  await plugin.settings.registerNumberSetting({
    id: SETTING_AUTO_HOUR,
    title: "Auto-rollover hour (0–23)",
    defaultValue: 7,
  });

  await plugin.settings.registerNumberSetting({
    id: SETTING_AUTO_MINUTE,
    title: "Auto-rollover minute (0–59)",
    defaultValue: 0,
  });

  await plugin.app.registerCommand({
    id: "daily_todo_rollover_run_now",
    name: "Daily Todo Rollover: run now",
    description:
      "Copy Repeating → Today and move finished todos Today → Completed.",
    action: async () => {
      console.log("[DailyTodo] Manual command invoked.");
      try {
        await runRollover(plugin);
        await plugin.storage.setLocal(STORAGE_LAST_RUN_DATE, todayKey());
      } catch (e) {
        console.error("[DailyTodo] Manual rollover error:", e);
        await plugin.app.toast("Error: " + String(e));
      }
    },
  });

  intervalId = window.setInterval(() => {
    maybeRunScheduledRollover(plugin);
  }, 60_000);
}

async function onDeactivate(plugin: ReactRNPlugin) {
  if (intervalId !== undefined) clearInterval(intervalId);
  console.log("[DailyTodo] Plugin deactivated.");
}

declareIndexPlugin(onActivate, onDeactivate);
