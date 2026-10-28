# Context handoffs

Portable provider handoffs are textual history. They do not claim native provider context parity.

Provider handoffs use either the full eligible app history or the delta since that provider last
participated. This path does not reconstruct provider-native session state, tool state, approvals,
or omitted text.

Fork merge-back hands the parent a pointer, not the fork's content: the fork's title and thread id,
plus an instruction to read the fork with `t3_thread_read` or ask it with `t3_thread_send` when
relevant. The parent timeline gets a `merge_back` turn item linking the fork, unless the transfer is
already known to be undeliverable.

Legacy v1 continuation uses a separate algorithm. It considers only user and assistant messages,
walks backward from the newest message, and builds a transcript suffix within a 32,000-character
budget. Do not describe that migration budget as the limit for portable handoffs.
