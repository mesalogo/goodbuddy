# Tasks

A Task is work that you explicitly create or confirm. It has exactly one associated Conversation, while one Conversation can have several Tasks. Ordinary chat requests and tool calls do not appear in Task Center automatically.

## Immediate and scheduled work

Choose New task in Task Center or the conversation task area. Enter the request; the name can be blank and GoodBuddy will derive one. Immediate execution is the default. You can choose a one-time, daily, or weekly schedule and select the current conversation, another conversation in the project, or a new conversation. The request, conversation, and schedule are submitted together.

A Task uses the associated conversation's Runtime, capabilities, knowledge scope, and workspace when it runs. It has no Ask / Execute mode and does not gain permission because it runs in the background. A new conversation does not copy source history.

## Task, Job, and Run

Task is the user-facing object. An immediate run, schedule occurrence, or retry may create internal Jobs and Runs, but they do not become new Task entries. Task Center aggregates status, progress, schedule, and attention items; Activity and Runtime panels provide detail.

A recurring schedule remains one Task. Pause, resume, run now, and cancel act on the Task. Deleting it normally stops future scheduling while keeping the Conversation and messages. Deleting one queued occurrence does not delete the Task.

## Queue and Heartbeat

Normal and Task messages use the same Conversation queue. A due occurrence waits while a reply is running. You can remove an unstarted item or choose Run now and interrupt. Later items can continue after cancellation or failure. Smart Heartbeat is not a Task Center item; it belongs to [Supervision](./supervision.html) and wakes incremental reviews and suggestions.
