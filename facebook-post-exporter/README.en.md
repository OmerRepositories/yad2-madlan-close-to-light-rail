# Facebook Group Post Text Exporter

A separate Chrome extension that collects post text as you scroll through a Facebook group or feed and downloads the collected text as one UTF-8 `.txt` file.

## What it exports

- Top-level post text from Facebook article cards that have entered the visible page during the current tab session.
- Posts are separated by clear numbered headings.
- A post URL is included when Facebook exposes a recognizable permalink.
- If a post's text changes or expands while its card remains in the page, the collected text is updated.

Comments are not collected. Text remains in the current tab's memory and is not sent anywhere. It is cleared when the tab is closed or reloaded. Only click **Export collected posts to TXT** to save a file locally.

This tool does not bypass access controls or retrieve posts Facebook has not loaded into the page. It captures text Facebook actually presents; collapsed “See more” text may not be included until Facebook renders it. Use the tool only where you have permission to access and export the content, and comply with Facebook's terms and applicable law.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this `facebook-post-exporter` directory.
5. Open a Facebook group or feed and scroll through the posts you want to include.
6. Click the extension icon and choose **Export collected posts to TXT**.

Each export is downloaded as `facebook-posts-<timestamp>.txt`.
