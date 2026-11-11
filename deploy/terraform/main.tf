locals {
  labels = {
    app = var.name
  }
}

resource "google_project_service" "apis" {
  for_each = toset([
    "compute.googleapis.com",
    "container.googleapis.com",
    "redis.googleapis.com",
    "sqladmin.googleapis.com",
    "servicenetworking.googleapis.com",
    "artifactregistry.googleapis.com",
  ])

  service            = each.value
  disable_on_destroy = false
}

resource "google_compute_network" "main" {
  name                    = "${var.name}-vpc"
  auto_create_subnetworks = false

  depends_on = [google_project_service.apis]
}

resource "google_compute_subnetwork" "main" {
  name          = "${var.name}-subnet"
  region        = var.region
  network       = google_compute_network.main.id
  ip_cidr_range = "10.10.0.0/20"

  private_ip_google_access = true
}

resource "google_compute_global_address" "private_services" {
  name          = "${var.name}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

resource "google_artifact_registry_repository" "images" {
  repository_id = var.name
  location      = var.region
  format        = "DOCKER"
  labels        = local.labels

  depends_on = [google_project_service.apis]
}

resource "google_container_cluster" "main" {
  name     = "${var.name}-gke"
  location = var.region

  enable_autopilot    = true
  network             = google_compute_network.main.id
  subnetwork          = google_compute_subnetwork.main.id
  deletion_protection = var.deletion_protection
  resource_labels     = local.labels

  ip_allocation_policy {}

  depends_on = [google_project_service.apis]
}

resource "google_redis_instance" "cache" {
  name               = "${var.name}-redis"
  region             = var.region
  tier               = var.redis_tier
  memory_size_gb     = var.redis_memory_gb
  redis_version      = "REDIS_7_2"
  authorized_network = google_compute_network.main.id
  connect_mode       = "PRIVATE_SERVICE_ACCESS"
  labels             = local.labels

  depends_on = [google_service_networking_connection.private_services]
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "main" {
  name                = "${var.name}-pg"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.deletion_protection

  settings {
    tier              = var.db_tier
    availability_type = var.db_availability_type
    user_labels       = local.labels

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.main.id
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
  }

  depends_on = [google_service_networking_connection.private_services]
}

resource "google_sql_database" "app" {
  name     = var.name
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "app" {
  name     = var.name
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}
