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
    # One replica for now. Probes and the autoscale rule come next; running
    # first, scaling second, so each is a decision that can be judged alone.
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "backend"
      image  = var.backend_image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "PORT"
        value = "3000"
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
    max_replicas = 1

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
    }
  }

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }
}
