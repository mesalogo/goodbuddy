# GoodBuddy User Guide

This guide is for a first GoodBuddy session. No GoodBuddy account is required. Conversations, projects, and notes are local by default; model providers, remote hosts, and external knowledge services receive data only when you configure and use them.

## Get started

### Install GoodBuddy

Choose a platform, processor architecture, and package from the [home page](https://mesalogo.github.io/goodbuddy/en.html#download). Windows provides an installer and a portable ZIP. Linux provides AppImage, DEB, and RPM. LoongArch uses a separate experimental preview channel. Start the app after installation; the first launch does not require sign-in.

### Initial setup

1. Open Settings, confirm the local data location, and prepare a text model connection.
2. In Model connections, enter the service URL, protocol, model name, and credentials, then run a connection test. See [Configure model connections](./connections.html) for the field rules.
3. Create a project and choose its project directory and Runtime. A project groups conversations, workspace access, and tasks.
4. Open or create a conversation and send a simple question first. Once that works, try files, knowledge, or remote operations.

### Projects and conversations

A project is a working scope that can contain many conversations. A conversation stores user messages, assistant replies, tool activity, and citations; it can also be associated with multiple tasks. New conversations usually inherit the project Runtime choice, while the composer can select a conversation-specific choice.

When changing projects or working directories, check the workspace and terminal scope in the [assistant workbar](./workbar.html). Before sending a request, confirm the Runtime, model, and knowledge scope so content goes to the intended service.

### Local data

Conversations, notes, task records, knowledge indexes, and settings are stored in the system application-data directory. Clear local data is an explicit Settings action with confirmation. Uninstalling the app does not delete exported files, remote directories, or provider-side records. See [Data and privacy](./privacy.html) for the data boundaries.

### Continue reading

Read [Core concepts](./concepts.html) for the relationship between projects, conversations, and Runtimes. Then configure a [knowledge base](./knowledge.html), create [tasks](./tasks.html), or set up a [remote project](./remote.html).
