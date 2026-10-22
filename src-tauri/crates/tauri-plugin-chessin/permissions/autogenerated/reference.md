## Default Permission

Default permissions for the Chessin plugin.

#### Granted Permissions

Every Chessin command is allowed; the plugin is only ever loaded by the Chessin
main window (see `src-tauri/capabilities/main.json`).

#### This default permission set includes the following:

- `allow-chessin-ping`
- `allow-cbh-to-pgn`
- `allow-cbh-detect-format`
- `allow-twocbh-to-pgn`
- `allow-store-get`
- `allow-store-set`
- `allow-store-delete`
- `allow-doc-put`
- `allow-doc-get`
- `allow-doc-list`
- `allow-doc-delete`
- `allow-doc-versions`
- `allow-doc-version-get`
- `allow-doc-restore-version`
- `allow-backup-library`
- `allow-job-upsert`
- `allow-job-list`
- `allow-job-delete`
- `allow-job-prune`
- `allow-eval-cache-get`
- `allow-eval-cache-put`
- `allow-card-upsert`
- `allow-card-list`
- `allow-card-get`
- `allow-card-delete`
- `allow-card-log`
- `allow-card-stats`
- `allow-move-to-trash`
- `allow-scan-chessbase`
- `allow-index-build`
- `allow-index-status`
- `allow-index-delete`
- `allow-index-position`
- `allow-index-pawn-candidates`
- `allow-index-games`
- `allow-book-lookup`
- `allow-book-info`
- `allow-tablebase-probe`
- `allow-tablebase-status`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`chessin:allow-backup-library`

</td>
<td>

Enables the backup_library command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-backup-library`

</td>
<td>

Denies the backup_library command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-book-info`

</td>
<td>

Enables the book_info command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-book-info`

</td>
<td>

Denies the book_info command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-book-lookup`

</td>
<td>

Enables the book_lookup command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-book-lookup`

</td>
<td>

Denies the book_lookup command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-card-delete`

</td>
<td>

Enables the card_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-card-delete`

</td>
<td>

Denies the card_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-card-get`

</td>
<td>

Enables the card_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-card-get`

</td>
<td>

Denies the card_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-card-list`

</td>
<td>

Enables the card_list command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-card-list`

</td>
<td>

Denies the card_list command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-card-log`

</td>
<td>

Enables the card_log command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-card-log`

</td>
<td>

Denies the card_log command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-card-stats`

</td>
<td>

Enables the card_stats command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-card-stats`

</td>
<td>

Denies the card_stats command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-card-upsert`

</td>
<td>

Enables the card_upsert command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-card-upsert`

</td>
<td>

Denies the card_upsert command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-cbh-detect-format`

</td>
<td>

Enables the cbh_detect_format command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-cbh-detect-format`

</td>
<td>

Denies the cbh_detect_format command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-cbh-to-pgn`

</td>
<td>

Enables the cbh_to_pgn command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-cbh-to-pgn`

</td>
<td>

Denies the cbh_to_pgn command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-chessin-ping`

</td>
<td>

Enables the chessin_ping command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-chessin-ping`

</td>
<td>

Denies the chessin_ping command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-doc-delete`

</td>
<td>

Enables the doc_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-doc-delete`

</td>
<td>

Denies the doc_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-doc-get`

</td>
<td>

Enables the doc_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-doc-get`

</td>
<td>

Denies the doc_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-doc-list`

</td>
<td>

Enables the doc_list command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-doc-list`

</td>
<td>

Denies the doc_list command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-doc-put`

</td>
<td>

Enables the doc_put command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-doc-put`

</td>
<td>

Denies the doc_put command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-doc-restore-version`

</td>
<td>

Enables the doc_restore_version command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-doc-restore-version`

</td>
<td>

Denies the doc_restore_version command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-doc-version-get`

</td>
<td>

Enables the doc_version_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-doc-version-get`

</td>
<td>

Denies the doc_version_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-doc-versions`

</td>
<td>

Enables the doc_versions command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-doc-versions`

</td>
<td>

Denies the doc_versions command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-eval-cache-get`

</td>
<td>

Enables the eval_cache_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-eval-cache-get`

</td>
<td>

Denies the eval_cache_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-eval-cache-put`

</td>
<td>

Enables the eval_cache_put command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-eval-cache-put`

</td>
<td>

Denies the eval_cache_put command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-index-build`

</td>
<td>

Enables the index_build command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-index-build`

</td>
<td>

Denies the index_build command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-index-delete`

</td>
<td>

Enables the index_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-index-delete`

</td>
<td>

Denies the index_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-index-games`

</td>
<td>

Enables the index_games command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-index-games`

</td>
<td>

Denies the index_games command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-index-pawn-candidates`

</td>
<td>

Enables the index_pawn_candidates command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-index-pawn-candidates`

</td>
<td>

Denies the index_pawn_candidates command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-index-position`

</td>
<td>

Enables the index_position command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-index-position`

</td>
<td>

Denies the index_position command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-index-status`

</td>
<td>

Enables the index_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-index-status`

</td>
<td>

Denies the index_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-job-delete`

</td>
<td>

Enables the job_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-job-delete`

</td>
<td>

Denies the job_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-job-list`

</td>
<td>

Enables the job_list command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-job-list`

</td>
<td>

Denies the job_list command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-job-prune`

</td>
<td>

Enables the job_prune command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-job-prune`

</td>
<td>

Denies the job_prune command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-job-upsert`

</td>
<td>

Enables the job_upsert command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-job-upsert`

</td>
<td>

Denies the job_upsert command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-move-to-trash`

</td>
<td>

Enables the move_to_trash command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-move-to-trash`

</td>
<td>

Denies the move_to_trash command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-scan-chessbase`

</td>
<td>

Enables the scan_chessbase command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-scan-chessbase`

</td>
<td>

Denies the scan_chessbase command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-store-delete`

</td>
<td>

Enables the store_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-store-delete`

</td>
<td>

Denies the store_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-store-get`

</td>
<td>

Enables the store_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-store-get`

</td>
<td>

Denies the store_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-store-set`

</td>
<td>

Enables the store_set command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-store-set`

</td>
<td>

Denies the store_set command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-tablebase-probe`

</td>
<td>

Enables the tablebase_probe command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-tablebase-probe`

</td>
<td>

Denies the tablebase_probe command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-tablebase-status`

</td>
<td>

Enables the tablebase_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-tablebase-status`

</td>
<td>

Denies the tablebase_status command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:allow-twocbh-to-pgn`

</td>
<td>

Enables the twocbh_to_pgn command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`chessin:deny-twocbh-to-pgn`

</td>
<td>

Denies the twocbh_to_pgn command without any pre-configured scope.

</td>
</tr>
</table>
