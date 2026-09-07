"""Report checks use an isolated database; existing scans are never touched."""
import importlib
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path

import scanner


class ReportParser(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.paths = []
        self.in_path = False
        self.current = ""
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag == "td" and dict(attrs).get("class") == "path":
            self.in_path = True
            self.current = ""

    def handle_data(self, data):
        if self.in_path:
            self.current += data

    def handle_endtag(self, tag):
        if tag == "td" and self.in_path:
            self.paths.append(self.current)
            self.in_path = False


class ReportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.original_db = scanner.DB_PATH
        scanner.DB_PATH = str(Path(cls.temp.name) / "test.db")
        cls.app_module = importlib.import_module("app")
        scanner.init_db()
        cls.client = cls.app_module.app.test_client()

    @classmethod
    def tearDownClass(cls):
        scanner.DB_PATH = cls.original_db
        cls.temp.cleanup()

    def setUp(self):
        conn = scanner.get_db()
        conn.execute("DELETE FROM files")
        conn.commit()
        conn.close()

    def insert(self, path, size=1, date="2026-01-01", ts=1, root="test-root"):
        conn = scanner.get_db()
        conn.execute(
            "INSERT INTO files(root,path,name,size,created_at,created_ts) VALUES(?,?,?,?,?,?)",
            (root, path, path.replace("\\", "/").rsplit("/", 1)[-1], size, date, ts),
        )
        conn.commit()
        conn.close()

    def export(self, mode="tree", **filters):
        response = self.client.get("/api/files/export", query_string={
            "root": "test-root", "year": "2026", "organization": mode, **filters,
        })
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment;", response.headers["Content-Disposition"])
        self.assertEqual(response.mimetype, "text/html")
        return response.get_data(as_text=True)

    def test_directory_tree_matches_requested_example(self):
        paths = [r"c:\a\a.txt", r"c:\a\b\c.txt", r"c:\a\x\a.txt",
                 r"c:\b\w\.txt", r"c:\b\x.txt", r"c:\b\z.txt"]
        for path in reversed(paths):
            self.insert(path)
        html = self.export()
        self.assertEqual(ReportParser(html).paths, paths)
        self.assertIn('class="folder"', html)

    def test_component_order_not_plain_path_order(self):
        paths = ["/a/b/file.txt", "/a/b.txt", "/a/bb/file.txt"]
        for path in reversed(paths):
            self.insert(path)
        self.assertEqual(ReportParser(self.export()).paths, paths)

    def test_size_and_creation_timestamp_directions(self):
        self.insert("/a", 30, ts=2)
        self.insert("/b", 10, ts=3)
        self.insert("/c", 20, ts=1)
        for mode, expected in {
            "size_asc": ["/b", "/c", "/a"], "size_desc": ["/a", "/c", "/b"],
            "date_asc": ["/c", "/a", "/b"], "date_desc": ["/b", "/a", "/c"],
        }.items():
            with self.subTest(mode=mode):
                self.assertEqual(ReportParser(self.export(mode)).paths, expected)

    def test_export_all_pages_and_same_filters_as_list(self):
        for i in range(105):
            self.insert(f"/keep/{i}.txt", date="2026-02-03")
        self.insert("/excluded/name.txt", date="2026-02-03")
        self.insert("/keep/other-day", date="2026-02-04")
        self.insert("/keep/other-month", date="2026-03-03")
        self.insert("/keep/other-year", date="2025-02-03")
        self.insert("/keep/other-root", date="2026-02-03", root="other")
        filters = {"month": "02", "day": "03", "q": "keep"}
        html = self.export(**filters, page=2, page_size=1)
        self.assertEqual(len(ReportParser(html).paths), 105)
        listing = self.client.get("/api/files", query_string={
            "root": "test-root", "year": "2026", **filters,
        }).get_json()
        self.assertEqual(listing["total"], 105)
        self.assertEqual(len(listing["files"]), 100)

    def test_html_escapes_paths_and_filter(self):
        path = '/folder/<script>alert("x")</script>&.txt'
        self.insert(path)
        html = self.export(q='<script>')
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)
        self.assertEqual(ReportParser(html).paths, [path])

    def test_empty_and_invalid_requests(self):
        self.assertIn("No files match this selection.", self.export())
        self.assertEqual(self.client.get("/api/files/export").status_code, 400)
        self.assertEqual(self.client.get("/api/files/export", query_string={
            "root": "test-root", "year": "2026", "organization": "invalid",
        }).status_code, 400)


if __name__ == "__main__":
    unittest.main()
