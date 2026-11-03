FROM certbot/certbot@sha256:34ee91d2f43008eb78a007d22f23ed4b2eaa9a454cb27ca2c042b49527a695b4

COPY docker/certbot/requirements.txt docker/certbot/verify_certifi.py /opt/security-certifi/
RUN python3 -m pip install --no-cache-dir --no-deps --only-binary=:all: --require-hashes --index-url https://pypi.org/simple -r /opt/security-certifi/requirements.txt \
    && python3 /opt/security-certifi/verify_certifi.py
