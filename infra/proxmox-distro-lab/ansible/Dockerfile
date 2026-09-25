FROM python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e

RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir ansible-core==2.19.11 \
    && ansible-galaxy collection install community.general:==13.2.0

COPY container-entrypoint.sh /usr/local/bin/control-room-ansible
RUN chmod 0755 /usr/local/bin/control-room-ansible

ENTRYPOINT ["/usr/local/bin/control-room-ansible"]
