## Default Permission

Default permissions for the Chessin plugin.

#### Granted Permissions

Every Chessin command is allowed; the plugin is only ever loaded by the Chessin
main window (see `src-tauri/capabilities/main.json`).

#### This default permission set includes the following:

- `allow-chessin-ping`
- `allow-cbh-to-pgn`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
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
</table>
