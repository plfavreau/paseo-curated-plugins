# SQL table

When an agent runs a database query, the plain shell row becomes a readable table. It recognises `psql`, `pgcli`, `supabase db query`, `sqlite3`, `duckdb`, `mysql`, `clickhouse` and wrappers named `sb-query`/`sb-write`, plus MCP database tools such as Supabase `execute_sql`.

The card shows the query on one line (tap to see it in full with the command), the row count, and an environment badge when the command passes `--env`, red for production. Each result becomes a grid with numbers right-aligned and real NULLs marked. Ten rows show at first, with a button for the rest. Tapping a row opens it as a vertical list of column and value, which helps with wide tables and long JSON. Each table can be copied as CSV, Markdown or JSON. A failed query shows the database error instead, and the raw output is always one tap away.

It reads psql's aligned output in both the unicode box and the plain ASCII styles (including multi-line cells and wide characters), JSON arrays of rows, and CSV when the command asks for it. Several statements in one command give several tables. Output that is neither a table nor an error, such as `INSERT 0 1`, keeps the normal row.

Up to 200 rows per result are kept on the card; the rest stays in the raw output. Everything runs in the app from the command's output: the plugin runs no query of its own.
