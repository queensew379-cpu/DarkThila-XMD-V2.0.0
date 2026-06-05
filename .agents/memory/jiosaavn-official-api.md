---
name: JioSaavn Official API + DES Decryption
description: How to get real full-song audio from JioSaavn without community mirrors
---

## Rule
Use `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=wap6dot0&q=QUERY&N=5` to search. Extract `more_info.encrypted_media_url`, decrypt with DES-ECB key `38346591`. Replace `_96.mp4` with `_320.mp4` when `more_info['320kbps'] === 'true'`.

**Why:** All community JioSaavn mirrors (saavn.dev, jiosaavn-api*.vercel.app, saavn.me) are permanently down. Official internal API is public and returns encrypted CDN URLs pointing to `aac.saavncdn.com`.

**How to apply:** Node 20 OpenSSL 3 blocks DES by default — must run with `NODE_OPTIONS=--openssl-legacy-provider` (set in package.json start script). Decryption uses `crypto.createDecipheriv('des-ecb', Buffer.from('38346591'), null)` with `setAutoPadding(false)` then strip trailing null bytes.
