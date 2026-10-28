import os

import uvicorn

uvicorn.run(
    "ielts_learning.app:build_app",
    factory=True,
    host=os.getenv("HOST", "127.0.0.1"),
    port=int(os.getenv("PORT", "4320")),
)
