# Tool Usage Rules

## bash
Only these commands are allowed: ls, grep, find, cat. No chaining (&&, ||, ;, |).

## read
Use for files only, never directories. Example: `read src/main.cpp`
To explore a directory, use `ls` instead.

## ls
Use to list directory contents. Example: `ls src/`

## edit
The `old_str` must match the file content EXACTLY — character for character, including all whitespace, indentation, and newlines.
Before editing, always `read` the file first to get the exact current content.
Copy the text you want to replace directly from the read output. Do not paraphrase or reformat it.
If an edit fails, re-read the file and try again with the exact content.

## write
Use to create new files or fully overwrite existing ones.
Prefer `edit` for partial changes.

## General
- Always read a file before editing it.
- If unsure of a file's path, use ls to explore first.