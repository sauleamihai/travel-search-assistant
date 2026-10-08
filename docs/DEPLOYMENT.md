# Ubuntu EC2 + Docker + Jenkins walkthrough

This guide assumes Ubuntu 24.04 LTS, a Git repository containing this project at its root, and one EC2 VM for an initial learning deployment. If Jenkins already exists, skip its installation. Check your OS with `cat /etc/os-release` before using the commands. Commands below run on Ubuntu unless explicitly labeled as local.

The pipeline is:

```text
Git checkout -> Docker test image -> API tests + JUnit report
             -> Docker runtime image -> optional Compose deployment -> health check

Browser -> HTTPS Nginx -> localhost:3000 -> application container -> API providers
```

Jenkins runs as an Ubuntu service, while the app runs in Docker. Node.js is supplied by the images, so the VM does not need a separate Node installation. This setup has one app instance and a brief interruption on replacement; it is not a zero-downtime deployment.

## 1. Prepare AWS access

For a combined learning VM, start with roughly 2 vCPUs, 4 GB RAM, and 30-50 GB of disk, then monitor resource use. These are sizing estimates, not a free-tier guarantee. Docker builds accumulate disk usage.

Configure the EC2 security group:

| Inbound port | Source | Purpose |
| --- | --- | --- |
| 22 | Your public IP `/32` | SSH administration and tunnels |
| 80 | Internet when configuring a public domain | HTTP redirect and certificate validation |
| 443 | Your IP initially; Internet when ready for public users | HTTPS app access |
| 3000, 8080 | No inbound rule | App and Jenkins stay private |

Allow outbound access for package downloads, Git, and API calls. AWS documents [security-group examples](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-rules-reference.html). Use a stable public address for DNS. If you use IPv6, configure its rules and DNS separately.

From your computer:

```sh
ssh -i /path/to/key.pem ubuntu@YOUR_EC2_PUBLIC_IP
```

## 2. Install Docker and Compose

Follow Docker's [Ubuntu installation instructions](https://docs.docker.com/engine/install/ubuntu/) to add its official apt repository, then install the Engine, Buildx, and Compose plugin. Review existing Docker packages before replacing anything on a VM already in use.

After adding that repository:

```sh
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git curl
sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu
```

Log out and reconnect so group membership takes effect, then verify:

```sh
docker version
docker compose version
docker run --rm hello-world
```

Docker group membership grants root-level control of the host. Give it only to trusted operators and build agents. See [Docker's post-installation documentation](https://docs.docker.com/engine/install/linux-postinstall/).

## 3. Install Jenkins LTS, if needed

Use Java 21 with the current Jenkins LTS repository. These commands follow the [Jenkins Ubuntu installation documentation](https://www.jenkins.io/doc/book/installing/linux/); consult that page if repository keys change.

```sh
sudo apt update
sudo apt install -y fontconfig openjdk-21-jre
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSL https://pkg.jenkins.io/debian-stable/jenkins.io-2026.key -o /etc/apt/keyrings/jenkins-keyring.asc
echo 'deb [signed-by=/etc/apt/keyrings/jenkins-keyring.asc] https://pkg.jenkins.io/debian-stable binary/' | sudo tee /etc/apt/sources.list.d/jenkins.list > /dev/null
sudo apt update
sudo apt install -y jenkins
sudo systemctl enable --now jenkins
```

Bind Jenkins to localhost with `sudo systemctl edit jenkins`:

```ini
[Service]
Environment="JENKINS_LISTEN_ADDRESS=127.0.0.1"
```

Then:

```sh
sudo systemctl restart jenkins
sudo systemctl status jenkins --no-pager
sudo cat /var/lib/jenkins/secrets/initialAdminPassword
```

Open another terminal **on your computer** and keep this tunnel running:

```sh
ssh -i /path/to/key.pem -N -L 8080:127.0.0.1:8080 ubuntu@YOUR_EC2_PUBLIC_IP
```

Visit http://localhost:8080, unlock Jenkins, install suggested plugins, and create your administrator account. Ensure **Pipeline**, **Git**, and **JUnit** plugins are installed. Jenkins uses shell commands for Docker here; the Docker Pipeline plugin is unnecessary.

## 4. Choose the build node

For the **single-VM learning setup only**, allow the Jenkins service to use Docker:

```sh
sudo usermod -aG docker jenkins
sudo systemctl restart jenkins
sudo -u jenkins docker version
```

In **Manage Jenkins -> Nodes -> Built-In Node -> Configure**, set one executor and add label `docker`. This gives builds control of the VM and access to deployment secrets; run only your trusted repository and trusted branch on it. Do not run pull requests from unknown contributors on this node.

For a production arrangement, keep the controller's executor count at zero and configure a separate trusted Linux agent with Java, Git, Docker, Compose, and curl. Assign label `docker` to the deployment agent. The current pipeline deploys on the Docker host used by that agent, and `/opt/travel-search/app.env` must exist there. Keep general CI agents separate from deployment agents. Jenkins explains the reason in [controller isolation guidance](https://www.jenkins.io/doc/book/security/controller-isolation/).

## 5. Store application configuration on the deployment host

For the single-VM Jenkins user:

```sh
sudo install -d -m 0750 -o root -g jenkins /opt/travel-search
sudo touch /opt/travel-search/app.env
sudo chown root:jenkins /opt/travel-search/app.env
sudo chmod 0640 /opt/travel-search/app.env
sudo nano /opt/travel-search/app.env
```

Add real values:

```dotenv
GROQ_API_KEY=replace_me
SERPAPI_API_KEY=replace_me
SEARCHAPI_API_KEY=replace_me
APIFY_TOKEN=
TRUST_PROXY_HOPS=1
```

Use `TRUST_PROXY_HOPS=1` only with the single Nginx proxy in step 8 and keep port 3000 bound to loopback. Use `0` when accessing the app directly through an SSH tunnel. Compose fixes the container port at 3000.

For a separate agent, replace the `jenkins` group with the deployment agent's group. Keep this file outside Git and the Jenkins checkout. Images contain no API keys; Compose injects values when creating the container. Docker administrators can inspect container environment variables, so protect host access. Secrets Manager with an EC2 IAM role is a later alternative to this protected local file; the included pipeline does not fetch AWS secrets.

## 6. Connect the repository to Jenkins

Commit and push the new Docker, test, Jenkins, and documentation files to your repository. No commit or push has been performed automatically. Merge the reviewed changes into your trusted deployment branch before enabling deployment.

1. For a private repository, add a read-only repository token or SSH key in **Manage Jenkins -> Credentials**. Select this credential in the job's SCM settings; never put it in the repository URL.
2. Create **New Item -> Pipeline**, for example `travel-search`.
3. Under Pipeline choose **Pipeline script from SCM**, Git, your repository URL, and credentials if needed.
4. Set the branch to `*/main` and Script Path to `Jenkinsfile`.
5. If the actual repository contains this app in a subdirectory, adjust checkout working directories and the script path before using this pipeline.
6. Save and select **Build Now** for the first run. It tests and builds without deploying. After Jenkins loads the parameters, use **Build with Parameters** for subsequent runs.

The deployment guard requires HEAD to match `origin/main`. If your deployment branch is `master` or another name, update both the job's SCM branch and the guard in `Jenkinsfile`. The current local feature branch must be merged or selected only for a test build.

Keep one job responsible for this deployment. `disableConcurrentBuilds()` serializes builds of that job; it does not lock other jobs sharing the same Compose project.

Start with manual builds. Optionally enable **Poll SCM** with `H/5 * * * *` after the first successful build; this avoids exposing Jenkins for a webhook. A polling-triggered build uses `DEPLOY=false` by default. If you later want automatic deployment, explicitly change that default after reviewing branch access and successful rollout tests.

## 7. Test and deploy

The pipeline builds a dedicated test image, runs syntax checks and nine API tests with networking disabled, then publishes the JUnit XML report under the build's **Test Result** page. Mocked data covers provider response mapping and fallback logic without spending API credits. Successful AI conversation streaming and real provider compatibility are not covered by these tests.

After a green build, run **Build with Parameters**, check **DEPLOY**, and start it. Jenkins builds a runtime image tagged with the commit prefix and build number, replaces the Compose service, and waits for the image health check. Failed tests block deployment. `/healthz` checks the HTTP process only; it does not validate external API credentials.

Check from the VM:

```sh
curl --fail http://127.0.0.1:3000/healthz
docker ps --filter label=com.docker.compose.project=travel-search
```

To try the UI before configuring a domain, use this tunnel **on your computer**:

```sh
ssh -i /path/to/key.pem -N -L 3000:127.0.0.1:3000 ubuntu@YOUR_EC2_PUBLIC_IP
```

Open http://localhost:3000. Exercise each tab with a small number of searches and a chat prompt. These manual checks use real provider quotas.

## 8. Add Nginx and HTTPS

Point your domain's A record at the VM's stable public address. Install Nginx:

```sh
sudo apt install -y nginx
sudo systemctl enable --now nginx
```

Copy `docs/nginx.conf` from a checkout of this repository to `/etc/nginx/sites-available/travel-search`. Replace `travel.example.com` with your actual domain. Then enable and validate it:

```sh
sudo ln -s /etc/nginx/sites-available/travel-search /etc/nginx/sites-enabled/travel-search
sudo nginx -t
sudo systemctl reload nginx
```

The supplied proxy disables buffering so chat events arrive as they are generated, and forwards the actual client IP for rate limiting. See [Nginx proxy directives](https://nginx.org/en/docs/http/ngx_http_proxy_module.html). This configuration assumes exactly one proxy hop; adding an AWS load balancer requires revisiting proxy trust.

Use Certbot to add HTTPS after DNS resolves and port 80 is reachable. For a fresh Ubuntu host using snap:

```sh
sudo apt install -y snapd
sudo snap install --classic certbot
sudo /snap/bin/certbot --nginx -d YOUR_DOMAIN
sudo /snap/bin/certbot renew --dry-run
```

Follow [Ubuntu's TLS certificate instructions](https://ubuntu.com/server/docs/how-to/security/obtain-tls-certificates/) if Certbot is already installed by another method. Visit `https://YOUR_DOMAIN` and verify both forms and streaming chat. The frontend uses same-origin `/api` URLs, so a separate frontend origin is unnecessary.

The app currently has no user authentication. Keep HTTPS access restricted to your IP for private use, or add authentication before allowing unrestricted access to paid search/chat endpoints. The existing rate limiter is not an account or spending limit.

## 9. Operate and roll back

From a checkout containing `compose.yaml`, inspect the service as a host administrator:

```sh
sudo env APP_ENV_FILE=/opt/travel-search/app.env docker compose -p travel-search ps
sudo env APP_ENV_FILE=/opt/travel-search/app.env docker compose -p travel-search logs --tail=100 app
docker image ls travel-search
```

The Jenkins console prints the image tag for each build. To restore a known-good local image, substitute its tag:

```sh
sudo env APP_ENV_FILE=/opt/travel-search/app.env APP_IMAGE=travel-search:PREVIOUS_TAG docker compose -p travel-search up -d --wait --wait-timeout 90
curl --fail http://127.0.0.1:3000/healthz
```

A failed deployment marks the build failed but does **not** automatically restore the previous container. Use the command above. Keep previous runtime images until you no longer need their rollback window; avoid indiscriminate image pruning. For future changes to Compose itself, use the matching known-good Compose revision as well as its image tag.

Compose restarts an exited app unless intentionally stopped. An `unhealthy` status alone does not restart a running container. Add host/container monitoring and disk alerts, and back up Jenkins configuration and your secret-management process. Container replacement loses in-memory chat histories. A host failure also loses local images unless you publish them to a registry.

When you move beyond one host, push tested images to Amazon ECR and deploy immutable tags/digests from a dedicated deployment agent. Use EC2 IAM roles for AWS permissions. The included pipeline intentionally uses local images and requires no AWS access keys, ECR repository, or registry login.

## Validation status

The API tests, syntax checks, and Compose configuration were validated locally. Docker Engine was unavailable on the development machine, so image builds and the Jenkins pipeline still need their first run on your Ubuntu VM. No AWS resources were changed and no live paid provider requests were made during this setup work.
