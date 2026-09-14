// 菜单名称：转为MD
const API_URL = "https://api.chen-group.cn/v1/document2md";
const API_KEY = Services.env.get("CHEN_GROUP_API_KEY")
    || Services.env.get("CHEN_GROUP_API_KEY_MEMBER");
const API_PROFILE = Services.env.get("DOCUMENT2MD_PROFILE");
const BATCH_CONCURRENCY = API_PROFILE === "server" ? 2 : 1;
const IMAGE_WRITE_CONCURRENCY = 2;
const SERVER_POLL_INTERVAL_MS = 5000;

const SYNC_ATTACHMENTS_TRIGGER = (
    typeof triggerType !== "undefined" && triggerType === "syncAttachments"
);

const STATUS_PROCESSING = "@md-处理中";
const STATUS_SUCCESS = "@md-已生成";
const STATUS_SKIPPED = "@md-跳过";
const STATUS_FAILED = "@md-失败";
const STATUS_REFERENCE_REVIEW = "@ref-待复核";
const MD_STATUSES = [STATUS_PROCESSING, STATUS_SUCCESS, STATUS_SKIPPED, STATUS_FAILED];
const FILE_ERROR_STATUSES = new Set([400, 413, 415, 422]);

const API_PROFILES = {
    server: {
        url: API_URL,
        authorization: `Bearer ${API_KEY}`,
        requiresKey: true,
    },
    local: {
        url: "http://127.0.0.1:18321/process",
        authorization: "",
        requiresKey: false,
    },
};

const ACTIVE_API = API_PROFILES[API_PROFILE];
const SOURCE_EXTENSIONS = new Set([
    ".pdf", ".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp",
    ".csv", ".docx", ".html", ".htm", ".pptx", ".xlsx",
]);
const IMAGE_EXTENSIONS = "bmp|jpeg|jpg|png|tif|tiff|webp";
const GENERATED_IMAGE_PATTERN = new RegExp(`_fig_\\d{3,}\\.(?:${IMAGE_EXTENSIONS})$`, "i");
let activeImageWrites = 0;
const imageWriteWaiters = [];


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
            throw new Error("转为MD只允许在“我的文库”中执行");
        }
        return;
    }
    const selected = getInvocationItems();
    if (selected.some(value => value.libraryID !== Zotero.Libraries.userLibraryID)) {
        throw new Error("转为MD只允许在“我的文库”中执行");
    }
    if (!selected.length) {
        const pane = Zotero.getActiveZoteroPane();
        if (pane && pane.getSelectedLibraryID() !== Zotero.Libraries.userLibraryID) {
            throw new Error("转为MD只允许在“我的文库”中执行");
        }
    }
}


function leafName(path) {
    return path.split(/[\\/]/).pop();
}


function extensionOf(filename) {
    const index = filename.lastIndexOf(".");
    return index >= 0 ? filename.slice(index).toLowerCase() : "";
}


function attachmentName(attachment) {
    if (attachment.attachmentFilename) {
        return attachment.attachmentFilename;
    }

    try {
        const path = attachment.getFilePath();
        if (path) {
            return leafName(path);
        }
    }
    catch (error) {}

    return attachment.getField("title")
        || `attachment-${attachment.id}`;
}


function sourceEntry(attachment) {
    if (!attachment || attachment.deleted) {
        return null;
    }
    const name = attachmentName(attachment);
    const extension = extensionOf(name);
    if (!SOURCE_EXTENSIONS.has(extension) || GENERATED_IMAGE_PATTERN.test(name)) {
        return null;
    }

    let path = null;
    try {
        path = attachment.getFilePath();
    }
    catch (error) {}

    return {
        attachment,
        file: { name, path },
    };
}


function getSourceAttachments(literature) {
    return literature.getAttachments()
        .map(id => Zotero.Items.get(id))
        .map(sourceEntry)
        .filter(Boolean)
        .sort((left, right) => left.file.name.localeCompare(
            right.file.name,
            undefined,
            { numeric: true, sensitivity: "base" }
        ));
}


function buildScopes(selectedItems) {
    const scopes = new Map();

    for (const value of selectedItems) {
        let literature;
        let selectedSource = null;

        if (value.isRegularItem()) {
            literature = value;
        }
        else if (value.isAttachment() && value.parentID) {
            literature = Zotero.Items.get(value.parentID);
            selectedSource = sourceEntry(value);
            if (!selectedSource) {
                continue;
            }
        }
        else {
            continue;
        }

        if (!literature || literature.deleted) {
            continue;
        }

        let scope = scopes.get(literature.id);
        if (!scope) {
            scope = {
                literature,
                allSources: false,
                selectedSources: new Map(),
            };
            scopes.set(literature.id, scope);
        }

        if (value.isRegularItem()) {
            scope.allSources = true;
            scope.selectedSources.clear();
        }
        else if (!scope.allSources) {
            scope.selectedSources.set(value.id, selectedSource);
        }
    }

    return [...scopes.values()].map(scope => ({
        literature: scope.literature,
        allSources: scope.allSources,
        sources: scope.allSources
            ? getSourceAttachments(scope.literature)
            : [...scope.selectedSources.values()].sort((left, right) =>
                left.file.name.localeCompare(
                    right.file.name,
                    undefined,
                    { numeric: true, sensitivity: "base" }
                )
            ),
    }));
}


function hasTag(item, tag) {
    return item.getTags().some(value => value.tag === tag);
}


function currentStatus(item) {
    return MD_STATUSES.find(tag => hasTag(item, tag)) || null;
}


async function setStatus(item, status) {
    for (const tag of MD_STATUSES) {
        item.removeTag(tag);
    }
    if (status) {
        item.addTag(status);
    }
    await item.saveTx();
}


function allSourcesHaveMarkdown(literature) {
    const attachmentIndex = buildAttachmentIndex(literature);
    const sources = getSourceAttachments(literature);
    return (
        sources.length > 0
        && sources.every(({ file }) => (
            attachmentIndex.has(`${file.name}.md`.toLowerCase())
        ))
    );
}


function buildAttachmentIndex(item) {
    const index = new Map();
    for (const attachmentID of item.getAttachments()) {
        const attachment = Zotero.Items.get(attachmentID);
        if (!attachment || !attachment.isAttachment()) {
            continue;
        }
        const name = attachmentName(attachment);
        if (!name) {
            continue;
        }
        const key = name.toLowerCase();
        const matches = index.get(key) || [];
        matches.push(attachment);
        index.set(key, matches);
    }
    return index;
}


function isGeneratedMarkdownAttachment(attachment) {
    return !!(
        attachment
        && attachment.isAttachment()
        && attachment.attachmentContentType === "text/markdown"
        && attachment.getField("title") === "Markdown"
        && extensionOf(attachmentName(attachment)) === ".md"
    );
}


async function cleanupStaleMarkdownAttachments(literature) {
    const expectedNames = new Set(
        getSourceAttachments(literature)
            .map(({ file }) => `${file.name}.md`.toLowerCase())
    );
    const removeIDs = [];

    for (const [name, attachments] of buildAttachmentIndex(literature)) {
        const generated = attachments.filter(isGeneratedMarkdownAttachment);
        if (!generated.length) {
            continue;
        }
        const remove = expectedNames.has(name) ? generated.slice(1) : generated;
        removeIDs.push(...remove.map(attachment => attachment.id));
    }

    if (removeIDs.length) {
        await Zotero.Items.erase(removeIDs);
    }
}


async function withImageWriteSlot(operation) {
    if (activeImageWrites < IMAGE_WRITE_CONCURRENCY) {
        activeImageWrites++;
    }
    else {
        await new Promise(resolve => imageWriteWaiters.push(resolve));
    }

    try {
        return await operation();
    }
    finally {
        const next = imageWriteWaiters.shift();
        if (next) {
            next();
        }
        else {
            activeImageWrites--;
        }
    }
}


async function writeMarkdownAttachment(item, attachmentIndex, filename, markdown) {
    const key = filename.toLowerCase();
    const existing = attachmentIndex.get(key) || [];
    if (existing.length > 1) {
        throw new Error(`输出附件重名：${filename}`);
    }

    let result;
    if (existing.length === 1) {
        result = existing[0];
        await Zotero.File.putContentsAsync(
            result.getFilePath(),
            markdown,
            "utf-8",
        );
    }
    else {
        const directory = await Zotero.Attachments.createTemporaryStorageDirectory();
        const fileObject = Zotero.File.pathToFile(directory.path);
        fileObject.append(filename);

        try {
            await Zotero.File.putContentsAsync(fileObject.path, markdown, "utf-8");
            result = await Zotero.Attachments.importFromFile({
                file: fileObject.path,
                parentItemID: item.id,
                title: "Markdown",
                contentType: "text/markdown",
            });
        }
        finally {
            if (directory.exists()) {
                directory.remove(true);
            }
        }
        attachmentIndex.set(key, [result]);
    }

    if (Zotero.FullText) {
        await Zotero.FullText.queueItem(result);
    }
    return result;
}


async function downloadAsset(url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        throw new Error("API 返回的图片资源不是 HTTP URL");
    }
    const headers = {};
    if (
        ACTIVE_API.authorization
        && url.startsWith(`${ACTIVE_API.url}/assets/`)
    ) {
        headers.Authorization = ACTIVE_API.authorization;
    }
    const response = await Zotero.HTTP.request("GET", url, {
        headers,
        responseType: "arraybuffer",
        successCodes: false,
        timeout: 0,
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}`);
    }
    return new Blob([response.response]);
}


function errorMessage(error) {
    return error && error.message ? error.message : String(error);
}


function markError(error, kind, stage, fileName) {
    if (!error || typeof error !== "object") {
        error = new Error(String(error));
    }
    error.kind = error.kind || kind;
    error.stage = error.stage || stage;
    error.fileName = error.fileName || fileName;
    return error;
}


function logError(error) {
    const message = [
        "[document2md]",
        error.fileName || "未知文件",
        error.stage || "未知阶段",
        errorMessage(error),
    ].join(" | ");
    const logged = new Error(message);
    if (error.stack) {
        logged.stack = `${logged.stack}\nCaused by:\n${error.stack}`;
    }
    Zotero.logError(logged);
}


function responseDetail(response) {
    const value = response.response;
    if (typeof value === "string") {
        return value.slice(0, 500);
    }
    if (value && typeof value === "object") {
        const detail = value.detail || value.error || value.message || value.errorMsg;
        if (detail) {
            return String(detail).slice(0, 500);
        }
    }
    return "无响应正文";
}


async function convertFile(file, attachment) {
    let stage = "读取源文件";
    try {
        if (!file.path) {
            throw markError(
                new Error("本地文件不可用"),
                "local",
                stage,
                file.name
            );
        }

        let body = await IOUtils.read(file.path);
        const headers = {
            "Content-Type": attachment.attachmentContentType || "application/octet-stream",
            "X-Filename": encodeURIComponent(file.name),
        };
        if (ACTIVE_API.authorization) {
            headers.Authorization = ACTIVE_API.authorization;
        }

        stage = API_PROFILE === "server" ? "提交 document2md 任务" : "请求 document2md";
        let response;
        try {
            response = await Zotero.HTTP.request(
                API_PROFILE === "server" ? "POST" : "PUT",
                ACTIVE_API.url,
                {
                    body,
                    headers,
                    responseType: "json",
                    successCodes: false,
                    timeout: 0,
                }
            );
        }
        finally {
            body = null;
        }

        stage = "检查 HTTP 响应";
        if (response.status < 200 || response.status >= 300) {
            const error = new Error(
                `HTTP ${response.status}: ${responseDetail(response)}`
            );
            error.status = response.status;
            throw markError(
                error,
                FILE_ERROR_STATUSES.has(response.status) ? "file" : "service",
                stage,
                file.name
            );
        }

        let payload = response.response;
        if (API_PROFILE === "server") {
            stage = "检查任务提交响应";
            const jobID = payload && payload.job_id;
            if (typeof jobID !== "string" || !jobID) {
                throw new Error("API 未返回 job_id");
            }

            while (true) {
                await new Promise(resolve => setTimeout(resolve, SERVER_POLL_INTERVAL_MS));
                stage = "查询 document2md 任务";
                const pollResponse = await Zotero.HTTP.request(
                    "GET",
                    `${ACTIVE_API.url}?job_id=${encodeURIComponent(jobID)}`,
                    {
                        headers: { Authorization: ACTIVE_API.authorization },
                        responseType: "json",
                        successCodes: false,
                        timeout: 0,
                    }
                );
                if (pollResponse.status < 200 || pollResponse.status >= 300) {
                    const error = new Error(
                        `HTTP ${pollResponse.status}: ${responseDetail(pollResponse)}`
                    );
                    error.status = pollResponse.status;
                    throw markError(
                        error,
                        FILE_ERROR_STATUSES.has(pollResponse.status) ? "file" : "service",
                        stage,
                        file.name
                    );
                }

                const job = pollResponse.response;
                if (job && (job.status === "pending" || job.status === "running")) {
                    continue;
                }
                if (job && job.status === "failed") {
                    const status = Number(job.http_status) || 500;
                    const error = new Error(job.error || "document2md 转换失败");
                    error.status = status;
                    throw markError(
                        error,
                        FILE_ERROR_STATUSES.has(status) ? "file" : "service",
                        "document2md 后台转换",
                        file.name
                    );
                }
                if (!job || job.status !== "succeeded") {
                    throw new Error("API 返回未知任务状态");
                }
                payload = job.result;
                break;
            }
        }

        stage = "检查 JSON 响应";
        if (!Array.isArray(payload) || !payload[0]) {
            throw new Error("API 返回格式不是文档数组");
        }

        const document = payload[0];
        if (
            typeof document.page_content !== "string"
            || !document.page_content.trim()
        ) {
            throw new Error("API 未返回 Markdown 正文");
        }
        if (
            document.assets !== undefined
            && (
                !document.assets
                || typeof document.assets !== "object"
                || Array.isArray(document.assets)
            )
        ) {
            throw new Error("API assets 格式无效");
        }
        return document;
    }
    catch (error) {
        if (!error.kind) {
            const kind = stage === "读取源文件" ? "local" : "service";
            markError(error, kind, stage, file.name);
        }
        throw error;
    }
}


async function generatedSidecars(storageDirectory) {
    const names = new Set();
    for (const path of await IOUtils.getChildren(storageDirectory.path)) {
        const name = leafName(path);
        if (GENERATED_IMAGE_PATTERN.test(name)) {
            names.add(name.toLowerCase());
        }
    }
    return names;
}


async function referencedLegacyFigures(attachmentIndex, markdownName) {
    const markdownAttachments = attachmentIndex.get(markdownName.toLowerCase()) || [];
    if (markdownAttachments.length > 1) {
        throw new Error(`输出附件重名：${markdownName}`);
    }
    if (!markdownAttachments.length) {
        return new Set();
    }

    const markdown = (await IOUtils.readUTF8(
        markdownAttachments[0].getFilePath()
    )).toLowerCase();
    const names = new Set();
    for (const name of attachmentIndex.keys()) {
        if (GENERATED_IMAGE_PATTERN.test(name) && markdown.includes(name)) {
            names.add(name);
        }
    }
    return names;
}


async function cleanupGeneratedAssets(
    attachmentIndex,
    storageDirectory,
    oldSidecars,
    keepNames,
    legacyNames
) {
    const keep = new Set([...keepNames].map(name => name.toLowerCase()));

    for (const name of oldSidecars) {
        if (!keep.has(name)) {
            await IOUtils.remove(PathUtils.join(storageDirectory.path, name), {
                ignoreAbsent: true,
            });
        }
    }

    const legacyAttachmentIDs = [];
    const migrate = new Set([
        ...legacyNames,
        ...keep,
    ]);
    for (const name of migrate) {
        const attachments = attachmentIndex.get(name) || [];
        for (const attachment of attachments) {
            legacyAttachmentIDs.push(attachment.id);
        }
    }
    if (legacyAttachmentIDs.length) {
        await Zotero.Items.erase(legacyAttachmentIDs);
    }
}


async function writeConvertedDocument(item, sourceName, document) {
    const assets = document.assets || {};
    const attachmentIndex = buildAttachmentIndex(item);
    const markdownName = `${sourceName}.md`;
    const legacyNames = await referencedLegacyFigures(attachmentIndex, markdownName);
    let markdownAttachment;

    try {
        markdownAttachment = await writeMarkdownAttachment(
            item,
            attachmentIndex,
            markdownName,
            document.page_content
        );
    }
    catch (error) {
        throw markError(error, "local", "写入 Markdown", sourceName);
    }

    const storageDirectory = Zotero.Attachments.getStorageDirectory(markdownAttachment);
    const oldSidecars = await generatedSidecars(storageDirectory);
    const keepNames = new Set();
    const filenames = Object.keys(assets);
    let nextIndex = 0;
    let assetError = null;

    async function runImageWorker() {
        while (!assetError) {
            const index = nextIndex++;
            if (index >= filenames.length) {
                return;
            }

            const filename = filenames[index];
            if (filename !== leafName(filename)) {
                assetError = markError(
                    new Error(`图片文件名无效：${filename}`),
                    "service",
                    `检查图片 ${filename}`,
                    sourceName
                );
                return;
            }

            keepNames.add(filename);
            try {
                const path = PathUtils.join(storageDirectory.path, filename);
                await withImageWriteSlot(async () => {
                    let blob;
                    try {
                        blob = await downloadAsset(assets[filename]);
                    }
                    catch (error) {
                        throw markError(
                            error,
                            "service",
                            `下载图片 ${filename}`,
                            sourceName
                        );
                    }
                    try {
                        await Zotero.File.putContentsAsync(path, blob);
                    }
                    catch (error) {
                        throw markError(
                            error,
                            "local",
                            `写入图片 ${filename}`,
                            sourceName
                        );
                    }
                });
            }
            catch (error) {
                assetError = error;
                return;
            }
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(IMAGE_WRITE_CONCURRENCY, filenames.length) },
            runImageWorker
        )
    );
    if (assetError) {
        throw assetError;
    }

    try {
        await cleanupGeneratedAssets(
            attachmentIndex,
            storageDirectory,
            oldSidecars,
            keepNames,
            legacyNames
        );
    }
    catch (error) {
        throw markError(error, "local", "清理废弃图片", sourceName);
    }

    try {
        await Zotero.Sync.Storage.Local.updateSyncStates(
            [markdownAttachment],
            "to_upload"
        );
    }
    catch (error) {
        throw markError(error, "local", "标记附件同步", sourceName);
    }

    return filenames.length;
}


function duplicateSourceNames(sources) {
    const seen = new Set();
    const duplicates = new Set();
    for (const { file } of sources) {
        const name = file.name.toLowerCase();
        if (seen.has(name)) {
            duplicates.add(file.name);
        }
        seen.add(name);
    }
    return [...duplicates];
}


async function processScope(scope) {
    const { literature, allSources, sources } = scope;
    const previousStatus = currentStatus(literature);
    let imageCount = 0;

    function finish(result) {
        return {
            ...result,
            imageCount,
        };
    }

    try {
        await cleanupStaleMarkdownAttachments(literature);
    }
    catch (error) {
        logError(error);
        await setStatus(literature, STATUS_FAILED);
        return finish({
            status: "failed",
            details: [`清理旧 Markdown｜${errorMessage(error)}`],
            stopBatch: true,
        });
    }

    if (
        previousStatus === STATUS_PROCESSING
        || (
            previousStatus === STATUS_SUCCESS
            && allSourcesHaveMarkdown(literature)
        )
    ) {
        return finish({ status: "skipped" });
    }
    if (!sources.length) {
        await setStatus(literature, STATUS_SKIPPED);
        return finish({
            status: "skipped",
            details: ["没有可处理的文件附件"],
        });
    }

    const duplicates = duplicateSourceNames(sources);
    if (duplicates.length) {
        await setStatus(literature, STATUS_FAILED);
        return finish({
            status: "failed",
            details: [`源附件文件名重复：${duplicates.join("、")}`],
        });
    }

    await setStatus(literature, STATUS_PROCESSING);
    if (allSources) {
        literature.removeTag(STATUS_REFERENCE_REVIEW);
    }

    const failures = [];
    let referenceReview = false;

    for (const { attachment, file } of sources) {
        try {
            const document = await convertFile(file, attachment);
            imageCount += await writeConvertedDocument(literature, file.name, document);
            referenceReview = referenceReview || document.reference_review === true;
        }
        catch (error) {
            logError(error);
            failures.push(
                `${file.name}｜${error.stage || "未知阶段"}｜${errorMessage(error)}`
            );

            if (error.kind !== "file") {
                await setStatus(literature, STATUS_FAILED);
                return finish({
                    status: "failed",
                    details: failures,
                    stopBatch: true,
                });
            }
        }
    }

    if (failures.length) {
        await setStatus(literature, STATUS_FAILED);
        return finish({
            status: "failed",
            details: failures,
        });
    }

    if (referenceReview) {
        literature.addTag(STATUS_REFERENCE_REVIEW);
    }

    if (allSources) {
        await setStatus(literature, STATUS_SUCCESS);
    }
    else {
        await setStatus(
            literature,
            previousStatus === STATUS_FAILED ? STATUS_FAILED : null
        );
    }

    return finish({
        status: "success",
        referenceReview,
    });
}


function formatDuration(milliseconds) {
    const seconds = milliseconds / 1000;
    if (seconds < 60) {
        return `${seconds.toFixed(1)}秒`;
    }
    return `${Math.floor(seconds / 60)}分${(seconds % 60).toFixed(1)}秒`;
}


function formatSeconds(milliseconds) {
    return (milliseconds / 1000).toFixed(1);
}


function formatShanghaiTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString("zh-CN", {
        hour12: false,
        timeZone: "Asia/Shanghai",
    });
}


function createBatchProgress(total, startedAt, processTotal) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline(`转为MD 0/${total}`);
    const progressLine = new progress.ItemProgress(null, "处理中");
    const literatureLine = new progress.ItemProgress(null, "");
    const timingLine = new progress.ItemProgress(null, "平均 0.0秒｜图片 0");
    progressLine.setProgress(0);
    progress.show();
    return {
        progress,
        progressLine,
        literatureLine,
        timingLine,
        startedAt,
        processTotal,
        processed: 0,
        averageMs: 0,
    };
}


function updateBatchProgress(batchProgress, completed, total, title, result) {
    const percent = total ? completed * 100 / total : 100;
    if (result.status !== "skipped") {
        batchProgress.processed++;
        batchProgress.averageMs = (
            Date.now() - batchProgress.startedAt
        ) / batchProgress.processed;
    }
    const averageMs = batchProgress.averageMs;
    const remaining = Math.max(0, batchProgress.processTotal - batchProgress.processed);
    const estimatedAt = averageMs ? Date.now() + averageMs * remaining : null;
    batchProgress.progress.changeHeadline(`转为MD ${completed}/${total}`);
    batchProgress.progressLine.setProgress(percent);
    batchProgress.progressLine.setText("处理中");
    batchProgress.literatureLine.setText(title);
    batchProgress.timingLine.setText(
        `预计 ${estimatedAt ? formatShanghaiTime(estimatedAt) : "--:--:--"}｜平均 ${formatSeconds(averageMs)}秒｜图片 ${result.imageCount}`
    );
}


function showProgressWindow(headline, descriptions) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline(headline);
    for (const description of descriptions) {
        progress.addDescription(description);
    }
    progress.show();
}


function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}


function showSummary(batchProgress, summary) {
    const progress = batchProgress.progress;
    progress.changeHeadline("转为MD");
    batchProgress.progressLine.setProgress(95);
    batchProgress.progressLine.setText("完成");
    batchProgress.literatureLine.setProgress(100);
    batchProgress.literatureLine.setText(
        `总计 ${summary.total}｜成功 ${summary.success}｜待复核 ${summary.reviewItems.length}｜跳过 ${summary.skipped}｜失败 ${summary.failed}`
    );
    batchProgress.timingLine.setProgress(100);
    batchProgress.timingLine.setText(
        `总耗时 ${formatDuration(summary.elapsedMs)}｜图片 ${summary.imageCount}`
    );
    for (const detail of summary.details) {
        progress.addDescription(detail);
    }
    for (const entry of summary.reviewItems) {
        progress.addDescription("待复核");
        progress.addDescription(
            `<a href="zotero://select/library/items/${entry.itemKey}">${escapeHtml(entry.title)}</a>`
        );
    }
    if (!summary.reviewItems.length) {
        progress.startCloseTimer(summary.failed ? 8000 : 3500);
    }
    return [
        `总计 ${summary.total}｜成功 ${summary.success}｜待复核 ${summary.reviewItems.length}｜跳过 ${summary.skipped}｜失败 ${summary.failed}`,
        `总耗时 ${formatDuration(summary.elapsedMs)}｜图片 ${summary.imageCount}`,
        ...summary.details,
    ].join("\n");
}


let activeBatchProgress = null;

await (async () => {
    const batchStarted = Date.now();
    if (typeof item !== "undefined" && item) {
        return;
    }
    assertPersonalLibrary();
    if (!ACTIVE_API) {
        throw new Error("环境变量 DOCUMENT2MD_PROFILE 必须为 local 或 server");
    }
    if (ACTIVE_API.requiresKey && !API_KEY) {
        throw new Error("缺少环境变量 CHEN_GROUP_API_KEY 或 CHEN_GROUP_API_KEY_MEMBER");
    }

    const scopes = buildScopes(getInvocationItems());
    if (!scopes.length) {
        throw new Error("请先选中文献或其可处理文件附件");
    }

    const summary = {
        total: scopes.length,
        success: 0,
        skipped: 0,
        failed: 0,
        stopped: false,
        details: [],
        reviewItems: [],
        imageCount: 0,
    };
    let completed = 0;
    let nextIndex = 0;
    const processTotal = scopes.filter(scope => {
        const status = currentStatus(scope.literature);
        return (
            status !== STATUS_PROCESSING
            && (
                status !== STATUS_SUCCESS
                || !allSourcesHaveMarkdown(scope.literature)
            )
        );
    }).length;
    if (!SYNC_ATTACHMENTS_TRIGGER) {
        activeBatchProgress = createBatchProgress(
            scopes.length,
            batchStarted,
            processTotal
        );
    }

    async function runWorker() {
        while (!summary.stopped) {
            const index = nextIndex++;
            if (index >= scopes.length) {
                return;
            }

            const scope = scopes[index];
            const result = await processScope(scope);
            summary[result.status]++;
            summary.imageCount += result.imageCount;
            completed++;

            const title = scope.literature.getField("title") || scope.literature.id;
            if (activeBatchProgress) {
                updateBatchProgress(
                    activeBatchProgress,
                    completed,
                    scopes.length,
                    title,
                    result
                );
            }

            if (result.status === "failed") {
                summary.details.push(`失败｜${title}｜${result.details.join("；")}`);
                if (result.stopBatch && !summary.stopped) {
                    summary.stopped = true;
                    summary.details.push("检测到服务或本地写入错误，已停止后续文献处理");
                }
            }
            else if (result.referenceReview) {
                summary.reviewItems.push({
                    itemKey: scope.literature.key,
                    title: scope.literature.getField("title") || scope.literature.id,
                });
            }
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(BATCH_CONCURRENCY, scopes.length) },
            runWorker
        )
    );

    summary.elapsedMs = Date.now() - batchStarted;
    const message = SYNC_ATTACHMENTS_TRIGGER
        ? `文献 ${summary.total}｜成功 ${summary.success}｜跳过 ${summary.skipped}｜失败 ${summary.failed}`
        : showSummary(activeBatchProgress, summary);
    if (!SYNC_ATTACHMENTS_TRIGGER) {
        activeBatchProgress = null;
    }
    return message;
})().catch(error => {
    if (activeBatchProgress) {
        activeBatchProgress.progress.close();
        activeBatchProgress = null;
    }
    if (!SYNC_ATTACHMENTS_TRIGGER) {
        showProgressWindow(
            "转为MD失败",
            [errorMessage(error)]
        );
    }
    Zotero.logError(error);
});
