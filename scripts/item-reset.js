// 菜单名称：条目重置
const RESET_ACTIONS = [
    ["清空产物", "1787933471942-TGdqst3V"],
    ["清空标签", "1788320932158-TGdqst3V"],
    ["清空分类", "1788320932160-TGdqst3V"],
];


function getInvocationItems() {
    if (typeof items !== "undefined" && Array.isArray(items) && items.length) {
        return items;
    }
    if (typeof item !== "undefined" && item) {
        return [item];
    }
    return [];
}

function assertPersonalLibrary() {
    if (typeof collection !== "undefined" && collection) {
        if (collection.libraryID !== Zotero.Libraries.userLibraryID) {
            throw new Error("条目重置只允许在“我的文库”中执行");
        }
        return;
    }
    const selected = getInvocationItems();
    if (selected.some(value => value.libraryID !== Zotero.Libraries.userLibraryID)) {
        throw new Error("条目重置只允许在“我的文库”中执行");
    }
    if (!selected.length) {
        const pane = Zotero.getActiveZoteroPane();
        if (!pane || pane.getSelectedLibraryID() !== Zotero.Libraries.userLibraryID) {
            throw new Error("条目重置只允许在“我的文库”中执行");
        }
    }
}


function parentLiterature(value) {
    if (value && value.isRegularItem()) {
        return value;
    }
    if (value && value.isAttachment() && value.parentID) {
        const parent = Zotero.Items.get(value.parentID);
        return parent && parent.isRegularItem() ? parent : null;
    }
    return null;
}


function collectCollection(collection, result) {
    for (const value of collection.getChildItems(false, false)) {
        const literature = parentLiterature(value);
        if (literature && !literature.deleted) {
            result.set(literature.id, literature);
        }
    }
    for (const child of Zotero.Collections.getByParent(collection.id, false)) {
        collectCollection(child, result);
    }
}


async function resolveItemIDs() {
    const result = new Map();
    if (typeof collection !== "undefined" && collection) {
        collectCollection(collection, result);
    }
    else {
        const selected = getInvocationItems();
        if (selected.length) {
            for (const value of selected) {
                const literature = parentLiterature(value);
                if (literature && !literature.deleted) {
                    result.set(literature.id, literature);
                }
            }
            return [...result.keys()];
        }
        const pane = Zotero.getActiveZoteroPane();
        if (!pane) {
            return [];
        }
        for (const value of await Zotero.Items.getAll(pane.getSelectedLibraryID(), false, false, false)) {
            if (value && value.isRegularItem() && !value.deleted) {
                result.set(value.id, value);
            }
        }
    }
    return [...result.keys()];
}


(async () => {
    if (typeof item !== "undefined" && item) {
        return;
    }
    assertPersonalLibrary();
    const itemIDs = await resolveItemIDs();
    if (!itemIDs.length) {
        throw new Error("当前选择中没有可重置的文献条目");
    }

    const selected = { value: 0 };
    const accepted = Services.prompt.select(
        Zotero.getMainWindow(),
        "条目重置",
        `对 ${itemIDs.length} 文献执行：`,
        RESET_ACTIONS.map(([name]) => name),
        selected
    );
    if (!accepted) {
        return;
    }

    await Zotero.ActionsTags.api.actionManager.dispatchActionByKey(
        RESET_ACTIONS[selected.value][1],
        { itemIDs }
    );
})().catch(error => {
    Zotero.logError(error);
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("条目重置失败");
    progress.addDescription(error && error.message ? error.message : String(error));
    progress.show();
});
