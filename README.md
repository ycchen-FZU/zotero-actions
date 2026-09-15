# Zotero Actions

课题组 Zotero 附件同步脚本。学生日常只需要使用 **同步附件**。

## 安装

1. 安装 [Zotero 10](https://www.zotero.org/download/)。
2. 安装 [Zotero Actions & Tags](https://github.com/windingwind/zotero-actions-tags/releases)。
3. 下载并解压 [zotero-actions-student.zip](https://github.com/ycchen-FZU/zotero-actions/releases/latest/download/zotero-actions-student.zip)。
4. 双击 `install.cmd`。
5. 按提示输入课题组 API Key。

安装完成后，在“我的文库”中右键文献或 Collection，即可看到 **同步附件**。

## 同步附件在做什么？

`检查课题组缓存 → 查找 PDF → 转为 Markdown → 上传缓存`

- 如果其他成员已经处理过这篇文献，会直接复用缓存。
- 缓存中没有时，会自动尝试查找 PDF。
- PDF 会自动转为 Markdown，主要是为了让课题组的 Zotero MCP 更稳定、更方便地读取全文，用于检索、问答、总结和文献分析。
- 自动检索失败时，会提示需要人工下载 PDF。
- 一个人成功处理后，其他成员通常可以直接复用 PDF、Markdown 和相关图片。

## 群组库怎么用？

课题组群组库只同步文献的元数据、标签和分类，不同步 PDF、Markdown 和图片。

需要全文时：

1. 将需要的文献从群组库加入“我的文库”。
2. 在“我的文库”中选中文献或 Collection。
3. 右键 → **同步附件**。

“同步附件”只在“我的文库”中运行。

## 更新

下载新版 `zotero-actions-student.zip` 后，重新运行 `install.cmd` 即可。

