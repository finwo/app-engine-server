# app-engine-server

Because google pulled their app-engine-php component from the gcloud-sdk, I needed a different way to get
the frontend developers within our company to host an old project locally.

This package provides such a way.

---

Example:

```sh
nodemon node -- index.js --config path/to/project/app.yaml --cgi $(which php-cgi)
```
