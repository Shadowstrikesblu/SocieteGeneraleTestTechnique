resource "azurerm_resource_group" "main" {
  name     = "rg-${var.project}"
  location = var.location
}

# Central log sink. Container Apps streams stdout/stderr and platform metrics
# here, which is what makes the system observable once it is deployed.
resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${var.project}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

# The shared boundary both apps run in: one virtual network, one log
# workspace, and internal DNS so the apps can address each other by name.
resource "azurerm_container_app_environment" "main" {
  name                       = "cae-${var.project}"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
}

# --- Backend -----------------------------------------------------------
# external_enabled = false is the security decision of this design: the app
# gets no public route at all. It is reachable only from inside the
# environment, which means only from the frontend.
resource "azurerm_container_app" "backend" {
  name                         = "ca-${var.project}-backend"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  ingress {
    external_enabled = false
    target_port      = 3000
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    # Never scale to zero: a cold start would be paid by the first user of the
    # day. Five is a ceiling that bounds the cost of a traffic spike, not a
    # capacity estimate.
    min_replicas = 1
    max_replicas = 5

    # Scale on in-flight HTTP requests per replica. KEDA polls every 30s and
    # will not scale back in for 300s, so a load test needs a plateau of at
    # least two minutes to show anything.
    #
    # Ten is deliberately low so that scale-out is observable within a short
    # test. A production threshold would come from latency measured under real
    # traffic, not from what makes a demo work.
    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = "10"
    }

    container {
      name   = "backend"
      image  = var.backend_image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "PORT"
        value = "3000"
      }

      # Liveness: is the process wedged? Only a restart fixes that, so it is
      # checked slowly and tolerates three failures. An aggressive liveness
      # probe turns a slow moment into a restart loop, causing the outage it
      # was meant to catch.
      liveness_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/api/health"
        initial_delay           = 5
        interval_seconds        = 10
        failure_count_threshold = 3
      }

      # Readiness: should this replica receive traffic right now? Checked
      # faster, because pulling a replica out of rotation is cheap and
      # reversible. This is also what lets a graceful shutdown drain safely.
      readiness_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/api/health"
        interval_seconds        = 5
        failure_count_threshold = 3
        success_count_threshold = 1
      }
    }
  }

  # CI deploys a new image tag on every push to main. Without this, the next
  # `terraform apply` would roll the running version back to the tag written
  # in variables.tf. Terraform owns the infrastructure, the pipeline owns
  # which version is running.
  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }
}

# --- Frontend ----------------------------------------------------------
# The only public entry point. nginx serves the static bundle and proxies
# /api to the backend over the environment's internal network.
resource "azurerm_container_app" "frontend" {
  name                         = "ca-${var.project}-frontend"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  ingress {
    external_enabled = true
    # 8080, not 80: nginx-unprivileged runs as a non-root user and cannot
    # bind a port below 1024.
    target_port = 8080
    transport   = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 1
    max_replicas = 5

    # Mirrors the backend rule: the frontend takes all public traffic, so it
    # must scale before the backend ever sees the load.
    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = "10"
    }

    container {
      name   = "frontend"
      image  = var.frontend_image
      cpu    = 0.25
      memory = "0.5Gi"

      # Referencing the backend's FQDN as an attribute is what tells Terraform
      # the backend must exist first. The ordering is derived from this line,
      # never declared by hand.
      env {
        name  = "BACKEND_URL"
        value = "https://${azurerm_container_app.backend.ingress[0].fqdn}"
      }

      # nginx must send this as the Host header and TLS SNI, so the backend's
      # ingress can tell which app the request is addressed to. Without it,
      # the request arrives labelled with the frontend's name and is answered
      # with 502.
      env {
        name  = "BACKEND_HOST"
        value = azurerm_container_app.backend.ingress[0].fqdn
      }

      # Both probes hit nginx's own /healthz, never /api. A frontend replica is
      # healthy when it can serve the page: it must not be restarted, nor
      # pulled from rotation, because the backend is having a bad minute.
      liveness_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/healthz"
        initial_delay           = 5
        interval_seconds        = 10
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/healthz"
        interval_seconds        = 5
        failure_count_threshold = 3
        success_count_threshold = 1
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }
}
