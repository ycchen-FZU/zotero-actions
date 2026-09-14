# Development

`scripts/` 是全部 Zotero JavaScript 的唯一源码。学生安装器只部署 `sync-attachments.js` 和 `document2md.js`。

## 脚本

| 脚本 | 类型 | 菜单 | 使用 | 调用关系 |
| --- | --- | --- | --- | --- |
| `sync-attachments.js` | 显式 Action | 同步附件 | 学生 / 开发 | 调用 `document2md` |
| `document2md.js` | 隐藏 Action | — | 内部 | 被“同步附件”调用 |
| `sync-to-group.js` | 显式 Action | 同步到课题组 | 开发 | 独立 |
| `item-reset.js` | 显式 Action | 条目重置 | 开发 | 调用三个清理 Action |
| `export-attachments.js` | 显式 Action | 导出附件 | 开发 | 独立 |
| `cleanup-document2md.js` | 隐藏 Action | — | 内部 | 被“条目重置”调用 |
| `clear-all-tags.js` | 隐藏 Action | — | 内部 | 被“条目重置”调用 |
| `clear-all-collections.js` | 隐藏 Action | — | 内部 | 被“条目重置”调用 |
| `auto-inbox-on-create.js` | 自动 Action | — | 开发 | `mainWindowLoad` |

## 固定 Action Key

| Action | Key |
| --- | --- |
| document2md | `1786529156738-JlgQvNK5` |
| 导出附件 | `1786972529220-TGdqst3V` |
| 清空产物 | `1787933471942-TGdqst3V` |
| 清空标签 | `1788320932158-TGdqst3V` |
| 清空分类 | `1788320932160-TGdqst3V` |
| 条目重置 | `item-reset` |
| 同步附件 | `sync-attachments` |
| 同步到课题组 | `sync-to-group` |

## 维护约定

1. `scripts/` 中的 JS 是唯一源码，不在 Actions & Tags 中长期直接修改。
2. 固定 Action Key 不随版本更新改变。
3. `sync-attachments` 只允许在“我的文库”运行。
4. `document2md` 保持隐藏，只由其他 Action 调用。
5. 学生安装器只安装 `sync-attachments` 和 `document2md`。
6. 学生环境固定使用 `DOCUMENT2MD_PROFILE=server`。
7. API Key 只写入用户环境变量，不写入仓库。
8. ProgressWindow 使用 Zotero 默认点击关闭行为，不显式设置 `closeOnClick`。
9. 修改后至少运行 `node --check`，并核对实际 Action 与源码一致。

## 学生安装器

`install.cmd` 调用 `installer.ps1`。安装器要求 Zotero 已关闭，并完成：

1. 定位默认 Zotero Profile。
2. 检查 Actions & Tags 是否已安装。
3. 备份 `prefs.js`。
4. 按固定 Action Key 安装或更新“同步附件”和隐藏 `document2md`。
5. 写入用户环境变量 `DOCUMENT2MD_PROFILE=server` 和 `CHEN_GROUP_API_KEY_MEMBER`。

重复运行安装器会更新原 Action，不会创建重复 Action。

Release 中的 `zotero-actions-student.zip` 只包含 README、安装器、`sync-attachments.js` 和 `document2md.js`。

