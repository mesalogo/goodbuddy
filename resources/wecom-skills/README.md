# WeCom CLI skill guides

Skill files copied unchanged from the official
[WecomTeam/wecom-cli](https://github.com/WecomTeam/wecom-cli) `skills/` directory
(MIT, see `LICENSE`) at commit `4c74ff28838d8fba267eaab5179d9d56f9ca61ae`
(`@wecom/cli` 1.3.4).

GoodBuddy serves the Markdown to models through the `wecom_guide` tool, limited
to the categories enabled in 应用 › 企业微信. The `scripts/` and `assets/` folders of
`wecomcli-doc` and `wecomcli-pptx` are included unchanged and run through the
`wecom_script` tool in an isolated Python virtual environment.

Licenses: the skills are MIT (`LICENSE`). `wecomcli-pptx/references/templates`
carries its own license file from upstream.

Update these files together with `WECOM_CLI_VERSION` in
`src/shared/wecom-contracts.ts`.
