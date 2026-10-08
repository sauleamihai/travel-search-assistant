pipeline {
    agent { label 'docker' }
    options {
        disableConcurrentBuilds()
        timeout(time: 20, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '20'))
        skipDefaultCheckout(true)
        skipStagesAfterUnstable()
    }
    parameters {
        booleanParam(name: 'DEPLOY', defaultValue: false,
            description: 'Deploy the tested main-branch image on this Docker host.')
    }
    environment {
        APP_ENV_FILE = '/opt/travel-search/app.env'
        COMPOSE_PROJECT_NAME = 'travel-search'
    }
    stages {
        stage('Checkout') {
            steps {
                deleteDir()
                checkout scm
                script {
                    env.IMAGE_TAG = sh(script: 'git rev-parse --short=12 HEAD', returnStdout: true).trim() + '-' + env.BUILD_NUMBER
                    env.APP_IMAGE = 'travel-search:' + env.IMAGE_TAG
                    env.TEST_CONTAINER = 'travel-search-test-' + env.IMAGE_TAG
                }
            }
        }
        stage('Test') {
            steps {
                sh '''
                    docker build --target test -t "travel-search-test:$IMAGE_TAG" .
                    docker create --network none --name "$TEST_CONTAINER" "travel-search-test:$IMAGE_TAG"
                    docker start --attach "$TEST_CONTAINER"
                    test "$(docker inspect --format='{{.State.ExitCode}}' "$TEST_CONTAINER")" = 0
                '''
            }
            post {
                always {
                    sh 'docker cp "$TEST_CONTAINER:/app/test-results.xml" test-results.xml || true'
                    junit testResults: 'test-results.xml', allowEmptyResults: false
                }
                cleanup {
                    sh 'docker rm -f "$TEST_CONTAINER" || true'
                }
            }
        }
        stage('Build runtime image') {
            steps {
                sh 'docker build --target runtime -t "$APP_IMAGE" .'
            }
        }
        stage('Deploy') {
            when { expression { params.DEPLOY } }
            steps {
                sh '''
                    # This job must check out the trusted main branch for deployments.
                    test "$(git rev-parse HEAD)" = "$(git rev-parse refs/remotes/origin/main)"
                    test -r "$APP_ENV_FILE"
                    docker compose up -d --wait --wait-timeout 90
                    curl --fail --silent --show-error http://127.0.0.1:3000/healthz
                '''
            }
        }
    }
    post {
        always {
            echo "Image for this build: ${env.APP_IMAGE}. Deployment requires DEPLOY=true."
        }
        cleanup {
            sh 'docker image rm "travel-search-test:$IMAGE_TAG" || true'
        }
    }
}
