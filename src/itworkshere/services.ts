/**
 * Service dependency detection.
 * Scans a repository to identify external services it needs at runtime
 * (Redis, Postgres, MySQL, MongoDB, etc.) before the user tries to run it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

export type ServiceRequirement = {
  name: string;
  /** e.g. "redis", "postgres", "mysql", "mongodb", "elasticsearch" */
  type: string;
  /** Where we learned about it */
  source: string;
  /** Default port to check */
  defaultPort: number | null;
  /** Whether this service is described in docker-compose, meaning `docker compose up` may start it */
  coveredByDockerCompose: boolean;
  /** Human-readable suggestion */
  suggestion: string;
};

// Package names → service type mapping
const PACKAGE_SERVICE_MAP: Record<string, { type: string; port: number }> = {
  redis: { type: "redis", port: 6379 },
  ioredis: { type: "redis", port: 6379 },
  "@upstash/redis": { type: "redis", port: 6379 },
  pg: { type: "postgres", port: 5432 },
  "pg-pool": { type: "postgres", port: 5432 },
  postgres: { type: "postgres", port: 5432 },
  mysql: { type: "mysql", port: 3306 },
  mysql2: { type: "mysql", port: 3306 },
  mongoose: { type: "mongodb", port: 27017 },
  mongodb: { type: "mongodb", port: 27017 },
  "@elastic/elasticsearch": { type: "elasticsearch", port: 9200 },
  "@opensearch-project/opensearch": { type: "elasticsearch", port: 9200 },
  "better-sqlite3": { type: "sqlite", port: null },
  sqlite3: { type: "sqlite", port: null },
  rabbitmq: { type: "rabbitmq", port: 5672 },
  amqplib: { type: "rabbitmq", port: 5672 },
  kafkajs: { type: "kafka", port: 9092 }
};

const SERVICE_SUGGESTIONS: Record<string, string> = {
  redis: "Start Redis with: docker run -p 6379:6379 redis:alpine  OR  brew services start redis",
  postgres: "Start Postgres with: docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:alpine",
  mysql: "Start MySQL with: docker run -p 3306:3306 -e MYSQL_ROOT_PASSWORD=root mysql:8",
  mongodb: "Start MongoDB with: docker run -p 27017:27017 mongodb/mongodb-community-server:latest",
  elasticsearch: "Start Elasticsearch with: docker run -p 9200:9200 -e discovery.type=single-node elasticsearch:8.12.0",
  sqlite: "SQLite is file-based — no server needed. Make sure the database file path is set correctly in your env.",
  rabbitmq: "Start RabbitMQ with: docker run -p 5672:5672 -p 15672:15672 rabbitmq:management-alpine",
  kafka: "Start Kafka with: docker run -p 9092:9092 apache/kafka:latest"
};

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type DockerCompose = {
  services?: Record<string, { image?: string; ports?: string[] }>;
};

export function detectServiceDependencies(rootDir: string): ServiceRequirement[] {
  const requirements = new Map<string, ServiceRequirement>();

  const dockerComposeServices = readDockerComposeServices(rootDir);

  // From package.json dependencies
  const packageJson = readPackageJson(rootDir);
  if (packageJson) {
    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    };

    for (const [pkgName, info] of Object.entries(PACKAGE_SERVICE_MAP)) {
      if (allDeps[pkgName]) {
        const key = info.type;
        if (!requirements.has(key)) {
          requirements.set(key, {
            name: info.type,
            type: info.type,
            source: `package.json (${pkgName})`,
            defaultPort: info.port,
            coveredByDockerCompose: dockerComposeServices.has(info.type),
            suggestion: SERVICE_SUGGESTIONS[info.type] ?? `Start a ${info.type} instance locally.`
          });
        }
      }
    }
  }

  // From docker-compose — surface services that aren't in package deps (e.g. nginx, minio)
  for (const [serviceType, serviceInfo] of dockerComposeServices) {
    if (!requirements.has(serviceType)) {
      requirements.set(serviceType, {
        name: serviceType,
        type: serviceType,
        source: serviceInfo.source,
        defaultPort: serviceInfo.port,
        coveredByDockerCompose: true,
        suggestion: `This service is defined in docker-compose. Run: docker compose up ${serviceType}`
      });
    } else {
      // Already detected from package.json — mark as covered
      const existing = requirements.get(serviceType)!;
      existing.coveredByDockerCompose = true;
    }
  }

  return [...requirements.values()];
}

type DockerComposeServiceInfo = { source: string; port: number | null };

function readDockerComposeServices(rootDir: string): Map<string, DockerComposeServiceInfo> {
  const found = new Map<string, DockerComposeServiceInfo>();
  const candidates = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

  for (const filename of candidates) {
    const filePath = join(rootDir, filename);
    if (!existsSync(filePath)) continue;

    let parsed: DockerCompose;
    try {
      parsed = YAML.parse(readFileSync(filePath, "utf8")) as DockerCompose;
    } catch {
      continue;
    }

    for (const [serviceName, service] of Object.entries(parsed.services ?? {})) {
      const image = service.image ?? "";
      const type = inferServiceTypeFromImage(serviceName, image);
      const port = inferPortFromPorts(service.ports);

      if (type && !found.has(type)) {
        found.set(type, { source: `${filename} (service: ${serviceName})`, port });
      }
    }
  }

  return found;
}

function inferServiceTypeFromImage(serviceName: string, image: string): string | null {
  const combined = `${serviceName} ${image}`.toLowerCase();
  if (/\bredis\b/.test(combined)) return "redis";
  if (/\bpostgres\b/.test(combined)) return "postgres";
  if (/\bmysql\b/.test(combined)) return "mysql";
  if (/\bmongo\b/.test(combined)) return "mongodb";
  if (/\belastic\b/.test(combined)) return "elasticsearch";
  if (/\brabbitmq\b/.test(combined)) return "rabbitmq";
  if (/\bkafka\b/.test(combined)) return "kafka";
  if (/\bnginx\b/.test(combined)) return "nginx";
  if (/\bminio\b/.test(combined)) return "minio";
  return null;
}

function inferPortFromPorts(ports?: string[]): number | null {
  if (!ports || ports.length === 0) return null;
  const first = ports[0];
  const match = String(first).match(/:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function readPackageJson(rootDir: string): PackageJson | null {
  const path = join(rootDir, "package.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}
