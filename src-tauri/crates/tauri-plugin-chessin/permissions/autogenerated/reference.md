## Default Permission

Default permissions for the Chessin plugin.

#### Granted Permissions

Every Chessin command is allowed; the plugin is only ever loaded by the Chessin
main window (see `src-tauri/capabilities/main.json`).

#### This default permission set includes the following:

- `allow-chessin-ping`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
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
