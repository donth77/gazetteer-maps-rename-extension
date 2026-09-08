# Privacy policy for Gazetteer

Last updated: 7 September 2026

Gazetteer does not collect, transmit, or sell any data. There is no server,
no analytics, and no account.

## What it stores

Your renaming rules: the place names you want changed, what you want them
changed to, and which languages each rule applies in. These live in
`chrome.storage.local`, which is storage on your own computer.

Nothing is stored anywhere else. The extension deliberately does not use
Chrome's sync storage, because that would upload your rules to Google.

## What it reads

To rename a place, the extension has to see the text Google Maps is showing.
It reads page text and map labels on Google Maps pages only, and only while a
Maps tab is open. That text is compared against your rules and, where there is
a match, replaced on screen. It is never recorded, copied, or sent anywhere.

The extension runs only on Google Maps addresses. It has no access to any
other website.

## Network

The extension makes no network requests of any kind. You can verify this: the
source is at https://github.com/donth77/gazetteer-maps-rename-extension and it requests
only the `storage` permission.

## Export files

Exporting your rules writes a file to a location you choose. That file is
yours; nothing is uploaded.

## Deleting your data

Removing the extension from Chrome deletes everything it stored. You can also
delete individual rules, or all of them, from the settings page.

## Contact

Questions or problems: https://github.com/donth77/gazetteer-maps-rename-extension/issues
