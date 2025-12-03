import {
  declareIndexPlugin,
  ReactRNPlugin,
} from "@remnote/plugin-sdk";

const SETTING_AUTO_ENABLED = "auto_roll_enabled";
const SETTING_AUTO_HOUR = "auto_roll_hour";
const SETTING_AUTO_MINUTE = "auto_roll_minute";

const STORAGE_LAST_RUN_DATE = "daily_todo_rollover_last_run";

let intervalId: number | undefined;

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
 * Find the Todo document that lives under a parent named "Notepad",
 * anywhere in the knowledge base.
 */
async function findTodoDocument(plugin: ReactRNPlugin) {
  console.log("[rollover] Global search for Todo under Notepad…");

  const results = await plugin.search.search(["Todo"]);
  console.log("[rollover] Found Todo candidates:", results.length);

  for (const rem of results) {
    const txt = normName(await richTextToString(plugin, rem.text));
    if (txt !== "Todo") continue;

    console.log("[rollover] Checking a Todo candidate:", rem._id);

    let parent = await rem.getParentRem();
    while (parent) {
      const pTextRaw = await richTextToString(plugin, parent.text);
      const pText = normName(pTextRaw);
      console.log(
        "[rollover]   parent raw:",
        JSON.stringify(pTextRaw),
        "norm:",
        JSON.stringify(pText)
      );

      if (pText === "Notepad") {
        console.log("[rollover] Matched path Notepad/Todo.");
        return { notepad: parent, todoDoc: rem };
      }

      parent = await parent.getParentRem();
    }
  }

  console.log("[rollover] No Notepad/Todo path found.");
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
 * Find Today / Repeating / Completed under the Todo doc.
 */
async function findTodoSections(plugin: ReactRNPlugin) {
  const { notepad, todoDoc } = await findTodoDocument(plugin);

  if (!notepad) {
    console.error("[rollover] No Notepad found in path.");
    return {
      notepad: undefined,
      todoDoc: undefined,
      today: undefined,
      repeating: undefined,
      completed: undefined,
    };
  }

  if (!todoDoc) {
    console.error("[rollover] Todo not found under Notepad.");
    return {
      notepad,
      todoDoc: undefined,
      today: undefined,
      repeating: undefined,
      completed: undefined,
    };
  }

  const today = await getChildByName(plugin, todoDoc, "Today");
  const repeating = await getChildByName(plugin, todoDoc, "Repeating");
  const completed = await getChildByName(plugin, todoDoc, "Completed");

  console.log("[rollover] Section presence:", {
    today: !!today,
    repeating: !!repeating,
    completed: !!completed,
  });

  return { notepad, todoDoc, today, repeating, completed };
}

/**
 * Main rollover logic with feature-detected transaction.
 */
async function runRollover(plugin: ReactRNPlugin) {
  console.log("[rollover] Starting rollover…");

  const { notepad, todoDoc, today, repeating, completed } =
    await findTodoSections(plugin);

  if (!notepad) {
    console.error("[rollover] Aborting: Notepad not found.");
    return;
  }
  if (!todoDoc) {
    console.error("[rollover] Aborting: Todo not found under Notepad.");
    return;
  }
  if (!today || !repeating || !completed) {
    console.error("[rollover] Missing required sections.", {
      today: !!today,
      repeating: !!repeating,
      completed: !!completed,
    });
    return;
  }

  console.log("[rollover] Structure OK. Preparing to modify…");

  const mutate = async () => {
    /***** 1) Move finished todos from Today → Completed (deduping) *****/
    const todayChildren = await today.getChildrenRem();
    console.log("[rollover] Today children before cleanup:", todayChildren.length);

    for (const child of todayChildren) {
      const isTodo = await child.isTodo();
      if (!isTodo) continue;

      const status = await child.getTodoStatus();
      if (status !== "Finished") continue;

      const plainText = normName(
        await richTextToString(plugin, child.text)
      );
      if (!plainText) {
        console.log("[rollover] Skipping finished todo with empty text.");
        continue;
      }

      console.log("[rollover] Archiving finished todo:", plainText);

      // Remove any existing duplicates in Completed
      const completedChildren = await completed.getChildrenRem();
      for (const c of completedChildren) {
        const cText = normName(
          await richTextToString(plugin, c.text)
        );
        if (!cText) continue;
        if (cText !== plainText) continue;

        console.log("[rollover] Deleting duplicate from Completed:", cText);
        const anyRem = c as any;
        if (typeof anyRem.remove === "function") {
          await anyRem.remove();
        } else {
          // Fallback: if remove() doesn't exist, just log it and keep it
          console.warn(
            "[rollover] remove() not available; cannot delete duplicate for",
            cText
          );
        }
      }

      // Turn into plain rem and move under Completed
      await child.setIsTodo(false);
      await child.setIsListItem(false);
      await child.setParent(completed, 0);
    }

    /***** Rebuild set of existing unfinished todos in Today *****/
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

    console.log(
      "[rollover] Existing unfinished todos in Today:",
      Array.from(existingUnfinished)
    );

    /***** 2) Copy children of Repeating → Today as new unfinished todos *****/
    const repeatingChildren = await repeating.getChildrenRem();
    console.log("[rollover] Repeating children:", repeatingChildren.length);
    
    for (const source of repeatingChildren) {
      const plainText = normName(
        await richTextToString(plugin, source.text)
      );

      // Skip empty lines
      if (!plainText) {
        console.log("[rollover] Skipping empty repeating item.");
        continue;
      }

      // Skip style/slot rems like "Size" under a heading
      if (plainText === "Size") {
        console.log("[rollover] Skipping style/slot rem 'Size'.");
        continue;
      }

      // Skip if an unfinished todo with same text already exists in Today
      if (existingUnfinished.has(plainText)) {
        console.log(
          "[rollover] Skipping duplicate repeating item already in Today:",
          plainText
        );
        continue;
      }

      console.log("[rollover] Copying repeating item:", plainText);

      // Ensure Repeating item itself is plain, not a todo
      if (await source.isTodo()) {
        await source.setIsTodo(false);
      }

      const newRem = await plugin.rem.createRem();
      if (!newRem) {
        console.error("[rollover] Failed to create new rem for:", plainText);
        continue;
      }

      await newRem.setParent(today);

      // Plain string text (no heading / formatting)
      await newRem.setText([plainText]);

      await newRem.setIsTodo(true);
      await newRem.setTodoStatus("Unfinished");

      // Track so later repeating items with same text don't create duplicates
      existingUnfinished.add(plainText);
    }
  };

  const appAny = plugin.app as any;
  if (typeof appAny.transaction === "function") {
    console.log("[rollover] Using plugin.app.transaction.");
    await appAny.transaction(mutate);
  } else {
    console.warn(
      "[rollover] plugin.app.transaction not available; running without transaction."
    );
    await mutate();
  }

  console.log("[rollover] Rollover completed.");
  await plugin.app.toast("Daily rollover done.");
}

/**
 * Auto daily trigger (if you want it).
 */
async function maybeRunScheduledRollover(plugin: ReactRNPlugin) {
  const enabled = await plugin.settings.getSetting<boolean>(SETTING_AUTO_ENABLED);
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
    console.log("[rollover] Auto-triggered rollover executing…");
    await runRollover(plugin);
    await plugin.storage.setLocal(STORAGE_LAST_RUN_DATE, today);
  } catch (e) {
    console.error("[rollover] Auto-rollover error:", e);
  }
}

/**
 * Plugin lifecycle
 */
async function onActivate(plugin: ReactRNPlugin) {
  console.log("[rollover] Plugin activated.");

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
      console.log("[rollover] Manual command invoked.");
      try {
        await runRollover(plugin);
        await plugin.storage.setLocal(STORAGE_LAST_RUN_DATE, todayKey());
      } catch (e) {
        console.error("[rollover] Manual rollover error:", e);
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
  console.log("[rollover] Plugin deactivated.");
}

declareIndexPlugin(onActivate, onDeactivate);
