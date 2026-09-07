"""Ordering and presentation of standalone file reports."""
from pathlib import PurePosixPath, PureWindowsPath

REPORT_ORDERS = {
    "size_asc": ("Size: smallest first", "size ASC, path ASC"),
    "size_desc": ("Size: largest first", "size DESC, path ASC"),
    "date_asc": ("Created: oldest first", "created_ts ASC, path ASC"),
    "date_desc": ("Created: newest first", "created_ts DESC, path ASC"),
    "tree": ("Directory tree: alphabetical", "path COLLATE DIRECTORY_TREE, path ASC"),
}


def path_parts(path):
    cls = PureWindowsPath if "\\" in path or (len(path) > 1 and path[1] == ":") else PurePosixPath
    return cls(path).parts


def directory_key(path):
    # Compare components, keeping a folder's descendants together.
    return tuple(part.casefold() for part in path_parts(path))


def report_rows(rows, tree):
    previous = ()
    for row in rows:
        parts = path_parts(row["path"])
        if tree:
            folders = parts[:-1]
            common = 0
            for old, new in zip(previous, folders):
                if old != new:
                    break
                common += 1
            for depth in range(common, len(folders)):
                yield {"kind": "folder", "name": folders[depth], "depth": min(depth, 12)}
            previous = folders
        yield {"kind": "file", "file": row, "depth": min(len(parts) - 1, 12) if tree else 0}
