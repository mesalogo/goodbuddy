# Build a knowledge base

A knowledge base brings local sources or a configured external knowledge service into retrieval. For a first setup, create a base, add sources, wait until it is searchable, and use it in the current conversation.

## Local workflow

Create a local base, add files, directories, or web sources, and wait for parsing and indexing. In the composer, explicitly select the knowledge scope and choose Model retrieves when needed or Retrieve before every request. Open citations to inspect the matching chunk, surrounding context, and source.

Knowledge scope is stored per Conversation. New conversations start with no selected base, and creating a base does not re-enable other bases you turned off. Each request uses only its explicit scope. The first mode lets the model decide whether to use read-only search; the second searches before the Runtime starts and shows zero results or degradation. Image generation does not run the pre-search.

Local retrieval can use full-text, Chinese phrase, vector, and graph channels. A citation is bounded evidence for the request, not proof that every answer sentence came from it. Check parsing, full-text, vector, and graph status separately. Vector failure can leave full-text and Chinese retrieval available, with the degraded channel shown. A failed rebuild keeps the last ready index.

## External knowledge bases

GoodBuddy can manage Dify, FastGPT, and RAGFlow instances and bind a remote base into the local list. Retrieval sends only the current query, remote ID, and saved settings. GoodBuddy checks returned chunks before showing citations.

External bindings are read-only. GoodBuddy does not create, edit, upload, or delete remote bases, documents, chunks, or graphs, and does not bulk-sync them. Removing a local binding does not delete remote data. Authentication, timeout, target, and provider failures remain visible and do not silently switch instances.
