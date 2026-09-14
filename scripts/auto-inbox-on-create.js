// Actions & Tags 事件：mainWindowLoad
// 新增正式文献时自动加入 0_收件箱；用启动基线避免旧文献因 modify 被误加入。

const INBOX_KEY = "9NRA75T8";
const OBSERVER_SLOT = "__chenGroupInboxObserverID";
const ALLOWED_ITEM_TYPES = new Set(["journalArticle", "preprint"]);
const pending = new Map();


function isEligible(item) {
    return !!(
        item
        && item.isRegularItem()
        && item.libraryID === Zotero.Libraries.userLibraryID
        && ALLOWED_ITEM_TYPES.has(Zotero.ItemTypes.getName(item.itemTypeID))
    );
}


const knownItemIDs = new Set(
    (await Zotero.Items.getAll(
        Zotero.Libraries.userLibraryID,
        false,
        false,
        false
    ))
        .filter(isEligible)
        .map(item => item.id)
);


async function processItem(itemID) {
    const item = Zotero.Items.get(itemID);
    if (!isEligible(item) || knownItemIDs.has(item.id)) {
        return;
    }

    item.addToCollection(INBOX_KEY);
    await item.saveTx();
    knownItemIDs.add(item.id);
}


function schedule(itemID) {
    const existing = pending.get(itemID);
    if (existing) {
        clearTimeout(existing);
    }
    pending.set(
        itemID,
        setTimeout(async () => {
            pending.delete(itemID);
            try {
                await processItem(itemID);
            }
            catch (error) {
                Zotero.logError(error);
            }
        }, 2500)
    );
}


if (Zotero[OBSERVER_SLOT]) {
    try {
        Zotero.Notifier.unregisterObserver(Zotero[OBSERVER_SLOT]);
    }
    catch (error) {}
}


const observer = {
    notify(event, type, ids) {
        if (type !== "item" || !["add", "modify"].includes(event)) {
            return;
        }
        for (const id of ids) {
            schedule(id);
        }
    },
};


Zotero[OBSERVER_SLOT] = Zotero.Notifier.registerObserver(
    observer,
    ["item"],
    "inbox-on-create"
);
