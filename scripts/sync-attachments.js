// 菜单名称：同步附件
const ATTACHMENTS_API = "https://api.chen-group.cn/v1/attachments";
const DOCUMENT2MD_ACTION_KEY = "1786529156738-JlgQvNK5";
const API_KEY = Services.env.get("CHEN_GROUP_API_KEY")
    || Services.env.get("CHEN_GROUP_API_KEY_MEMBER");
const IMAGE_EXTENSIONS = "bmp|jpeg|jpg|png|tif|tiff|webp";
const GENERATED_FIG_PATTERN = new RegExp(`_fig_\\d{3,}\\.(?:${IMAGE_EXTENSIONS})$`, "i");
const MD_STATUSES = ["@md-处理中", "@md-已生成", "@md-跳过", "@md-失败"];
const SYNC_CONCURRENCY = 3;
const ATTACHMENTS_POLL_INTERVAL_MS = 2000;


function getInvocationItems() {
    if (typeof items !== "undefined" && Array.isArray(items) && items.length) {
        return items;
    }
    if (typeof item !== "undefined" && item) {
        return [item];
    }
    return [];
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


function addLiterature(map, value) {
    const literature = parentLiterature(value);
    if (literature && !literature.deleted) {
        map.set(literature.id, literature);
    }
}


function collectCollectionLiterature(sourceCollection, result) {
    for (const child of sourceCollection.getChildItems(false, false)) {
        addLiterature(result, child);
    }
    for (const childCollection of Zotero.Collections.getByParent(sourceCollection.id, false)) {
        collectCollectionLiterature(childCollection, result);
    }
}


async function resolveLiterature() {
    const result = new Map();
    if (typeof collection !== "undefined" && collection) {
        if (collection.libraryID !== Zotero.Libraries.userLibraryID) {
            throw new Error("同步附件只允许在“我的文库”中执行");
        }
        collectCollectionLiterature(collection, result);
    }
    else {
        const selected = getInvocationItems();
        if (selected.length) {
            for (const value of selected) {
                addLiterature(result, value);
            }
        }
        else {
            const pane = Zotero.getActiveZoteroPane();
            if (!pane || pane.getSelectedLibraryID() !== Zotero.Libraries.userLibraryID) {
                throw new Error("同步附件只允许在“我的文库”中执行");
            }
            for (const value of await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false, false, false)) {
                addLiterature(result, value);
            }
        }
    }

    for (const literature of result.values()) {
        if (literature.libraryID !== Zotero.Libraries.userLibraryID) {
            throw new Error("同步附件只允许在“我的文库”中执行");
        }
    }
    return [...result.values()];
}


function normalizeDoi(value) {
    let doi = String(value || "").trim();
    doi = doi.replace(/^doi:\s*/i, "");
    doi = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi.toLowerCase() : "";
}


function citationKey(literature) {
    return String(literature.getField("citationKey") || "").trim();
}


function titleOf(literature) {
    return literature.getField("title") || citationKey(literature) || literature.key;
}


function attachmentName(attachment) {
    return attachment.attachmentFilename
        || attachment.getField("title")
        || `attachment-${attachment.id}`;
}


function isPdfAttachment(attachment) {
    return !!(
        attachment
        && attachment.isAttachment()
        && (
            attachment.attachmentContentType === "application/pdf"
            || /\.pdf$/i.test(attachmentName(attachment))
        )
    );
}


async function localPdf(literature) {
    for (const attachmentID of literature.getAttachments()) {
        const attachment = await Zotero.Items.getAsync(attachmentID);
        if (!isPdfAttachment(attachment)) {
            continue;
        }
        const path = await attachment.getFilePathAsync();
        if (path && await IOUtils.exists(path)) {
            return attachment;
        }
    }
    return null;
}


async function localMarkdown(literature, pdfAttachment = null) {
    const expected = pdfAttachment
        ? `${attachmentName(pdfAttachment)}.md`.toLowerCase()
        : "";
    let fallback = null;
    for (const attachmentID of literature.getAttachments()) {
        const attachment = await Zotero.Items.getAsync(attachmentID);
        if (!attachment || !attachment.isAttachment()) {
            continue;
        }
        const name = attachmentName(attachment);
        if (!/\.md$/i.test(name)) {
            continue;
        }
        const path = await attachment.getFilePathAsync();
        if (!path || !await IOUtils.exists(path)) {
            continue;
        }
        if (expected && name.toLowerCase() === expected) {
            return attachment;
        }
        if (!fallback && (
            attachment.attachmentContentType === "text/markdown"
            || attachment.getField("title") === "Markdown"
        )) {
            fallback = attachment;
        }
    }
    return fallback;
}


function authHeaders(extra = {}) {
    return { Authorization: `Bearer ${API_KEY}`, ...extra };
}


async function getRemoteState(doi, cacheOnly = false) {
    const cacheOnlyQuery = cacheOnly ? "&cache_only=1" : "";
    let response = await Zotero.HTTP.request(
        "GET",
        `${ATTACHMENTS_API}?doi=${encodeURIComponent(doi)}${cacheOnlyQuery}`,
        {
            headers: authHeaders(),
            responseType: "json",
            successCodes: false,
            timeout: 0,
        }
    );
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`附件服务 HTTP ${response.status}`);
    }
    let payload = response.response;
    while (!cacheOnly && payload.pdf && payload.pdf.status === "searching") {
        const jobID = payload.pdf.job_id;
        if (!jobID) {
            throw new Error("附件服务未返回全文搜索任务 ID");
        }
        await new Promise(resolve => setTimeout(resolve, ATTACHMENTS_POLL_INTERVAL_MS));
        response = await Zotero.HTTP.request(
            "GET",
            `${ATTACHMENTS_API}?doi=${encodeURIComponent(doi)}&job_id=${encodeURIComponent(jobID)}`,
            {
                headers: authHeaders(),
                responseType: "json",
                successCodes: false,
                timeout: 0,
            }
        );
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`附件服务 HTTP ${response.status}`);
        }
        payload = response.response;
    }
    if (payload.pdf && payload.pdf.status === "failed") {
        throw new Error(payload.pdf.error || "全文搜索失败");
    }
    return payload;
}


function isPdfBuffer(buffer) {
    if (!buffer || buffer.byteLength < 5) {
        return false;
    }
    const bytes = new Uint8Array(buffer, 0, 5);
    return bytes[0] === 0x25
        && bytes[1] === 0x50
        && bytes[2] === 0x44
        && bytes[3] === 0x46
        && bytes[4] === 0x2D;
}


async function downloadPdf(literature, key, url) {
    const response = await Zotero.HTTP.request("GET", url, {
        responseType: "arraybuffer",
        successCodes: false,
        timeout: 0,
    });
    if (response.status < 200 || response.status >= 300 || !isPdfBuffer(response.response)) {
        throw new Error(`PDF 下载失败：HTTP ${response.status}`);
    }

    const directory = await Zotero.Attachments.createTemporaryStorageDirectory();
    const file = Zotero.File.pathToFile(directory.path);
    file.append(`${key}.pdf`);
    try {
        await Zotero.File.putContentsAsync(file.path, new Blob([response.response]));
        return await Zotero.Attachments.importFromFile({
            file: file.path,
            parentItemID: literature.id,
            title: "PDF",
            contentType: "application/pdf",
        });
    }
    finally {
        if (directory.exists()) {
            directory.remove(true);
        }
    }
}


function nsFile(path) {
    const file = Components.classes["@mozilla.org/file/local;1"]
        .createInstance(Components.interfaces.nsIFile);
    file.initWithPath(path);
    return file;
}


async function setMarkdownSuccess(literature) {
    for (const tag of MD_STATUSES) {
        literature.removeTag(tag);
    }
    literature.addTag("@md-已生成");
    await literature.saveTx();
}


async function installBundle(literature, doi) {
    const response = await Zotero.HTTP.request(
        "GET",
        `${ATTACHMENTS_API}?doi=${encodeURIComponent(doi)}&download=bundle`,
        {
            headers: authHeaders(),
            responseType: "arraybuffer",
            successCodes: false,
            timeout: 0,
        }
    );
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Bundle 下载失败：HTTP ${response.status}`);
    }

    const directory = await Zotero.Attachments.createTemporaryStorageDirectory();
    const zipFile = Zotero.File.pathToFile(directory.path);
    zipFile.append("bundle.zip");
    await Zotero.File.putContentsAsync(zipFile.path, new Blob([response.response]));

    const reader = Components.classes["@mozilla.org/libjar/zip-reader;1"]
        .createInstance(Components.interfaces.nsIZipReader);
    const extracted = [];
    try {
        reader.open(zipFile);
        const entries = reader.findEntries("*");
        while (entries.hasMore()) {
            const name = entries.getNext();
            if (!name || /[\\/]/.test(name) || reader.getEntry(name).isDirectory) {
                continue;
            }
            const output = Zotero.File.pathToFile(directory.path);
            output.append(name);
            reader.extract(name, output);
            extracted.push(output.path);
        }
    }
    finally {
        reader.close();
    }

    const markdownFiles = extracted.filter(path => /\.md$/i.test(path));
    if (markdownFiles.length !== 1) {
        if (directory.exists()) {
            directory.remove(true);
        }
        throw new Error("Bundle 中 Markdown 文件数量必须为 1");
    }

    let markdown = null;
    try {
        markdown = await Zotero.Attachments.importFromFile({
            file: markdownFiles[0],
            parentItemID: literature.id,
            title: "Markdown",
            contentType: "text/markdown",
        });
        const storage = Zotero.Attachments.getStorageDirectory(markdown);
        for (const path of extracted) {
            const name = path.split(/[\\/]/).pop();
            if (!GENERATED_FIG_PATTERN.test(name)) {
                continue;
            }
            nsFile(path).copyToFollowingLinks(storage, name);
        }
        if (Zotero.FullText) {
            await Zotero.FullText.queueItem(markdown);
        }
        await setMarkdownSuccess(literature);
        return markdown;
    }
    catch (error) {
        if (markdown) {
            try {
                await Zotero.Items.erase([markdown.id]);
            }
            catch (cleanupError) {
                Zotero.logError(cleanupError);
            }
        }
        throw error;
    }
    finally {
        if (directory.exists()) {
            directory.remove(true);
        }
    }
}


async function createBundle(markdown) {
    const markdownPath = await markdown.getFilePathAsync();
    if (!markdownPath || !await IOUtils.exists(markdownPath)) {
        throw new Error("Markdown 本地文件不存在");
    }
    const storage = Zotero.Attachments.getStorageDirectory(markdown);
    const directory = await Zotero.Attachments.createTemporaryStorageDirectory();
    const zipFile = Zotero.File.pathToFile(directory.path);
    zipFile.append("bundle.zip");
    const writer = Components.classes["@mozilla.org/zipwriter;1"]
        .createInstance(Components.interfaces.nsIZipWriter);
    writer.open(zipFile, 0x04 | 0x08 | 0x20);
    try {
        const markdownFile = nsFile(markdownPath);
        writer.addEntryFile(
            markdownFile.leafName,
            writer.COMPRESSION_DEFAULT,
            markdownFile,
            false
        );
        for (const path of await IOUtils.getChildren(storage.path)) {
            const file = nsFile(path);
            if (!file.isFile() || !GENERATED_FIG_PATTERN.test(file.leafName)) {
                continue;
            }
            writer.addEntryFile(
                file.leafName,
                writer.COMPRESSION_DEFAULT,
                file,
                false
            );
        }
    }
    finally {
        writer.close();
    }
    return { directory, path: zipFile.path };
}


async function uploadFile(doi, kind, path, contentType) {
    const body = await IOUtils.read(path);
    const response = await Zotero.HTTP.request(
        "PUT",
        `${ATTACHMENTS_API}?doi=${encodeURIComponent(doi)}&kind=${kind}`,
        {
            headers: authHeaders({ "Content-Type": contentType }),
            body,
            responseType: "json",
            successCodes: false,
            timeout: 0,
        }
    );
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`${kind} 上传失败：HTTP ${response.status}`);
    }
    return response.response;
}


let document2mdQueue = Promise.resolve();


async function runDocument2md(pdf) {
    const previous = document2mdQueue;
    let release;
    document2mdQueue = new Promise(resolve => {
        release = resolve;
    });
    await previous;
    try {
        await Zotero.ActionsTags.api.actionManager.dispatchActionByKey(
            DOCUMENT2MD_ACTION_KEY,
            {
                itemIDs: [pdf.id],
                triggerType: "syncAttachments",
            }
        );
    }
    finally {
        release();
    }
}


function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}


function itemLink(entry) {
    return `<a href="zotero://select/library/items/${entry.item.key}">${escapeHtml(entry.title)}</a>`;
}


function externalLink(url, text = "手动下载 PDF") {
    return `<a href="${escapeHtml(url)}">${text}</a>`;
}


function showFinalSummary(batch, summary) {
    const issueCount = summary.manual.length
        + summary.notFound.length
        + summary.mdOnly.length
        + summary.failed.length;
    const progress = batch.progress;
    progress.changeHeadline("同步附件");
    batch.statusLine.setProgress(95);
    batch.statusLine.setText("完成");
    batch.titleLine.setProgress(100);
    batch.titleLine.setText(
        issueCount
            ? `总计 ${summary.total}｜更新 ${summary.updated}｜跳过 ${summary.unchanged}｜待审 ${issueCount}`
            : `总计 ${summary.total}｜更新 ${summary.updated}｜跳过 ${summary.unchanged}`
    );

    for (const entry of summary.manual) {
        progress.addDescription("待人工");
        progress.addDescription(itemLink(entry));
        progress.addDescription(externalLink(entry.url));
    }
    for (const entry of summary.notFound) {
        progress.addDescription("待人工");
        progress.addDescription(itemLink(entry));
        progress.addDescription("未找到全文");
    }
    for (const entry of summary.mdOnly) {
        progress.addDescription("待审");
        progress.addDescription(itemLink(entry));
        progress.addDescription("缺 PDF，已保留 Markdown");
        if (entry.url) {
            progress.addDescription(externalLink(entry.url, "查看全文页面"));
        }
    }
    for (const entry of summary.failed) {
        const error = String(entry.error).replace(/^附件服务\s+/i, "");
        progress.addDescription("失败");
        progress.addDescription(itemLink(entry));
        progress.addDescription(escapeHtml(error));
    }
    if (!issueCount) {
        progress.startCloseTimer(4000);
    }
}


function createBatchProgress(total) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline(`同步附件 0/${total}`);
    const statusLine = new progress.ItemProgress(null, "处理中");
    const titleLine = new progress.ItemProgress(null, "");
    statusLine.setProgress(0);
    progress.show();
    return { progress, statusLine, titleLine };
}


function updateBatchProgress(batch, processed, total, title, status = "处理中") {
    const percent = total ? processed * 100 / total : 100;
    batch.progress.changeHeadline(`同步附件 ${processed}/${total}`);
    batch.statusLine.setProgress(percent);
    batch.statusLine.setText(status);
    batch.titleLine.setText(title);
}


let activeBatch = null;


(async () => {
    if (typeof item !== "undefined" && item) {
        return;
    }
    if (!API_KEY) {
        throw new Error("缺少环境变量 CHEN_GROUP_API_KEY 或 CHEN_GROUP_API_KEY_MEMBER");
    }

    const literature = await resolveLiterature();
    if (!literature.length) {
        throw new Error("当前选择中没有可同步的文献条目");
    }

    const summary = {
        total: literature.length,
        updated: 0,
        unchanged: 0,
        manual: [],
        notFound: [],
        mdOnly: [],
        failed: [],
    };
    const batch = createBatchProgress(literature.length);
    activeBatch = batch;
    let processed = 0;

    let nextIndex = 0;
    async function runWorker() {
        while (true) {
            const index = nextIndex++;
            if (index >= literature.length) {
                return;
            }
            const literatureItem = literature[index];
            const title = titleOf(literatureItem);
            const entry = { item: literatureItem, title };
            try {
                updateBatchProgress(batch, processed, literature.length, title);
                const doi = normalizeDoi(literatureItem.getField("DOI"));
                if (!doi) {
                    summary.unchanged++;
                    continue;
                }
                const key = citationKey(literatureItem);
                if (!key) {
                    throw new Error("缺少 citationkey");
                }

                let pdf = await localPdf(literatureItem);
                let markdown = await localMarkdown(literatureItem, pdf);
                let changed = false;

                updateBatchProgress(
                    batch,
                    processed,
                    literature.length,
                    title,
                    "处理中 · 检查服务器"
                );
                let remote = await getRemoteState(doi, true);

                if (pdf) {
                    if (remote.pdf.status !== "cached") {
                        updateBatchProgress(
                            batch,
                            processed,
                            literature.length,
                            title,
                            "处理中 · 上传至服务器"
                        );
                        const pdfPath = await pdf.getFilePathAsync();
                        const uploaded = await uploadFile(doi, "pdf", pdfPath, "application/pdf");
                        changed = uploaded && uploaded.pdf === "created";
                    }
                }
                else {
                    if (remote.pdf.status !== "cached" && !markdown) {
                        updateBatchProgress(
                            batch,
                            processed,
                            literature.length,
                            title,
                            "处理中 · 从服务器获取"
                        );
                        remote = await getRemoteState(doi);
                    }
                    if (remote.pdf.status === "cached") {
                        pdf = await downloadPdf(literatureItem, key, remote.pdf.url);
                        changed = true;
                    }
                    else if (markdown) {
                        summary.mdOnly.push({
                            ...entry,
                            url: remote.pdf.status === "manual" ? remote.pdf.url : "",
                        });
                    }
                    else if (remote.pdf.status === "manual" && remote.pdf.url) {
                        summary.manual.push({ ...entry, url: remote.pdf.url });
                        continue;
                    }
                    else {
                        summary.notFound.push(entry);
                        continue;
                    }
                }

                if (!markdown) {
                    if (remote.bundle.status === "cached") {
                        updateBatchProgress(
                            batch,
                            processed,
                            literature.length,
                            title,
                            "处理中 · 从服务器获取"
                        );
                        markdown = await installBundle(literatureItem, doi);
                        changed = true;
                    }
                    else {
                        updateBatchProgress(
                            batch,
                            processed,
                            literature.length,
                            title,
                            "处理中 · Markdown 转换"
                        );
                        await runDocument2md(pdf);
                        markdown = await localMarkdown(literatureItem, pdf);
                        if (!markdown) {
                            throw new Error("document2md 未生成 Markdown");
                        }
                        changed = true;
                    }
                }

                if (remote.bundle.status !== "cached") {
                    updateBatchProgress(
                        batch,
                        processed,
                        literature.length,
                        title,
                        "处理中 · 上传至服务器"
                    );
                    const bundle = await createBundle(markdown);
                    try {
                        await uploadFile(doi, "bundle", bundle.path, "application/zip");
                    }
                    finally {
                        if (bundle.directory.exists()) {
                            bundle.directory.remove(true);
                        }
                    }
                    changed = true;
                }

                if (changed) {
                    summary.updated++;
                }
                else {
                    summary.unchanged++;
                }
            }
            catch (error) {
                summary.failed.push({
                    ...entry,
                    error: error && error.message ? error.message : String(error),
                });
                Zotero.logError(error);
            }
            finally {
                processed++;
                updateBatchProgress(batch, processed, literature.length, title);
            }
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(SYNC_CONCURRENCY, literature.length) },
            runWorker
        )
    );

    showFinalSummary(batch, summary);
    activeBatch = null;
})().catch(error => {
    Zotero.logError(error);
    if (activeBatch) {
        activeBatch.progress.close();
    }
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("同步附件失败");
    const message = error && error.message ? error.message : String(error);
    progress.addDescription(escapeHtml(message).replace(/^附件服务\s+/i, ""));
    progress.show();
    activeBatch = null;
});
