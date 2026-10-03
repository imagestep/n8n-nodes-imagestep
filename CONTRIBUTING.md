# Contributing

Thank you for helping. A few things are different here from most repositories.

## This repository is an export

The node is developed in ImageStep's main repository, where the API and every client change together in one commit,
and exported here as snapshots. So:

- **Issues** are the best way to report a bug or ask for something. Please say which version of the node and of n8n
  you run, and include the `requestId` from the error if the API answered one.
- **Pull requests** are welcome. We do not merge them here: we apply the change in the main repository, credit you
  with a `Co-authored-by` line, and it arrives here with the next export, at which point we close your pull request
  with a link to it.
- `lib/static-ops.json`, the node's fallback list of ops, is written from the API's catalogue upstream; please
  describe a change to it rather than editing it.

The SDKs, the CLI, the MCP server and the recipes are in [imagestep/imagestep-sdk](https://github.com/imagestep/imagestep-sdk).

## English only

Code, comments, documentation, issues, pull requests and commit messages here are in English.

## Issue references in comments

Comments in the code cite issues as `imagestep#123` or `#123`. Those numbers are in our internal tracker, not in this
repository's issues; they are kept so a line can be traced back to the decision behind it.

## Running the checks

```sh
pnpm install
pnpm test        # unit tests; they build the node with tsc (strict) first
pnpm run build   # dist/, what n8n loads
```
