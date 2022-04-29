// Copyright 2016-2022, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as schema from "../schema-types";
import { getSubnetSpecs, SubnetSpec } from "./subnetDistributor";

interface VpcData {
  vpc: aws.ec2.Vpc;
  subnets: aws.ec2.Subnet[];
  routeTables: aws.ec2.RouteTable[];
  routes: aws.ec2.Route[];
  routeTableAssociations: aws.ec2.RouteTableAssociation[];
  igw: aws.ec2.InternetGateway;
  natGateways: aws.ec2.NatGateway[];
  eips: aws.ec2.Eip[];
  publicSubnetIds: pulumi.Output<string>[];
  privateSubnetIds: pulumi.Output<string>[];
  isolatedSubnetIds: pulumi.Output<string>[];
}

export class Vpc extends schema.Vpc<VpcData> {
  constructor(name: string, args: schema.VpcArgs, opts: pulumi.ComponentResourceOptions = {}) {
    super(name, args, opts);

    const data = pulumi.output(this.getData());

    this.vpc = data.vpc;
    this.subnets = data.subnets;
    this.routeTables = data.routeTables;
    this.routes = data.routes;
    this.routeTableAssociations = data.routeTableAssociations;
    this.internetGateway = data.igw;
    this.natGateways = data.natGateways;
    this.eips = data.eips;

    this.privateSubnetIds = data.privateSubnetIds;
    this.publicSubnetIds = data.publicSubnetIds;
    this.isolatedSubnetIds = data.isolatedSubnetIds;

    this.vpcId = data.vpc.id;
  }

  protected async initialize(props: {
    name: string;
    args: schema.VpcArgs;
    opts: pulumi.ComponentResourceOptions;
  }) {
    const { name, args } = props;
    if (args.availabilityZoneNames && args.numberOfAvailabilityZones) {
      throw new Error(
        "Only one of [availabilityZoneNames] and [numberOfAvailabilityZones] can be specified",
      );
    }

    const availabilityZones =
      args.availabilityZoneNames ?? (await this.getDefaultAzs(args.numberOfAvailabilityZones));

    const natGatewayStrategy: schema.NatGatewayStrategyInputs =
      args.natGateways?.strategy ?? "OnePerAz";
    const allocationIds = args.natGateways?.elasticIpAllocationIds ?? [];
    validateEips(natGatewayStrategy, allocationIds, availabilityZones);

    const cidrBlock = args.cidrBlock ?? "10.0.0.0/16";

    const subnetSpecs = getSubnetSpecs(name, cidrBlock, availabilityZones, args.subnetSpecs);
    validateNatGatewayStrategy(natGatewayStrategy, subnetSpecs);

    const vpc = new aws.ec2.Vpc(
      name,
      {
        ...args,
        cidrBlock,
        tags: {
          ...args.tags,
          Name: name,
        },
      },
      { parent: this },
    );

    // We unconditionally create the IGW (even if it's not needed because we
    // only have isolated subnets) because AWS does not charge for it, and
    // therefore there's no harm in adding it, whereas conditional resources
    // must be declared in the constructor, which significantly complicates the
    // code.
    const igw = new aws.ec2.InternetGateway(
      `${name}`,
      {
        vpcId: vpc.id,
      },
      { parent: vpc, dependsOn: [vpc] },
    );

    const subnets: aws.ec2.Subnet[] = [];
    const routeTables: aws.ec2.RouteTable[] = [];
    const routeTableAssociations: aws.ec2.RouteTableAssociation[] = [];
    const routes: aws.ec2.Route[] = [];
    const natGateways: aws.ec2.NatGateway[] = [];
    const eips: aws.ec2.Eip[] = [];
    const publicSubnetIds: pulumi.Output<string>[] = [];
    const privateSubnetIds: pulumi.Output<string>[] = [];
    const isolatedSubnetIds: pulumi.Output<string>[] = [];

    for (let i = 0; i < availabilityZones.length; i++) {
      subnetSpecs
        .filter((x) => x.azName === availabilityZones[i])
        .sort(compareSubnetSpecs)
        .forEach((spec) => {
          const subnet = new aws.ec2.Subnet(
            spec.subnetName,
            {
              vpcId: vpc.id,
              availabilityZone: spec.azName,
              mapPublicIpOnLaunch: spec.type === "Public",
              cidrBlock: spec.cidrBlock,
              tags: {
                Name: spec.subnetName,
              },
            },
            { parent: vpc, dependsOn: [vpc] },
          );
          subnets.push(subnet);
          if (spec.type === "Public") {
            publicSubnetIds.push(subnet.id);
          } else if (spec.type === "Private") {
            privateSubnetIds.push(subnet.id);
          } else {
            isolatedSubnetIds.push(subnet.id);
          }

          const routeTable = new aws.ec2.RouteTable(
            spec.subnetName,
            {
              vpcId: vpc.id,
              tags: {
                Name: spec.subnetName,
              },
            },
            { parent: subnet, dependsOn: [subnet] },
          );
          routeTables.push(routeTable);

          const routeTableAssoc = new aws.ec2.RouteTableAssociation(
            spec.subnetName,
            {
              routeTableId: routeTable.id,
              subnetId: subnet.id,
            },
            { parent: routeTable, dependsOn: [routeTable] },
          );
          routeTableAssociations.push(routeTableAssoc);

          if (
            spec.type === "Public" &&
            shouldCreateNatGateway(natGatewayStrategy, natGateways.length, i)
          ) {
            const createEip = allocationIds.length === 0;

            if (createEip) {
              const eip = new aws.ec2.Eip(
                `${name}-${i + 1}`,
                {},
                { parent: subnet, dependsOn: [subnet] },
              );
              eips.push(eip);
            }

            const natGateway = new aws.ec2.NatGateway(
              `${name}-${i + 1}`,
              {
                subnetId: subnet.id,
                allocationId: createEip ? eips[i].allocationId : allocationIds[i],
                tags: {
                  Name: `${name}-${i + 1}`,
                },
              },
              { parent: subnet, dependsOn: [subnet] },
            );
            natGateways.push(natGateway);
          }

          if (spec.type === "Public") {
            // Public subnets communicate directly with the internet via the Internet Gateway.
            const route = new aws.ec2.Route(
              spec.subnetName,
              {
                routeTableId: routeTable.id,
                gatewayId: igw.id,
                destinationCidrBlock: "0.0.0.0/0",
              },
              { parent: routeTable, dependsOn: [routeTable] },
            );
            routes.push(route);
          } else if (spec.type === "Private") {
            // Private subnets communicate indirectly with the internet via a NAT Gateway.

            // Because we've already validated the strategy and have ensured that public subnets are created
            // first via the sort above, we know the necessary NAT Gateway already exists.
            const natGatewayId =
              natGatewayStrategy === "Single" ? natGateways[0].id : natGateways[i].id;

            const route = new aws.ec2.Route(
              spec.subnetName,
              {
                routeTableId: routeTable.id,
                natGatewayId,
                destinationCidrBlock: "0.0.0.0/0",
              },
              { parent: routeTable, dependsOn: [routeTable] },
            );
            routes.push(route);
          }

          // Isolated subnets do not have any route to the internet and therefore need no route created.
        });
    }

    return {
      vpc,
      subnets,
      igw,
      routeTables,
      routeTableAssociations,
      routes,
      natGateways,
      eips,
      privateSubnetIds,
      publicSubnetIds,
      isolatedSubnetIds,
    };
  }

  async getDefaultAzs(azCount?: number): Promise<string[]> {
    const desiredCount = azCount ?? 3;
    const result = await aws.getAvailabilityZones();
    if (result.names.length < desiredCount) {
      throw new Error(
        `The configured region for this provider does not have at least ${desiredCount} Availability Zones. Either specify an explicit list of zones in availabilityZoneNames or choose a region with at least ${desiredCount} AZs.`,
      );
    }
    return result.names.slice(0, desiredCount);
  }
}

export function validateEips(
  natGatewayStrategy: schema.NatGatewayStrategyInputs,
  eips: pulumi.Input<string>[] | undefined,
  availabilityZones: string[] = [],
) {
  // We are strict about matching NAT Gateway strategies with the number of supplied EIPs (if supplied) because if
  // EIPs are supplied, we are assuming the user has a scenario where all outbound traffic from the VPC must come
  // from known IP addresses, e.g. because they are hitting a data center-based service with a firewall that must
  // allowlist specific IP addresses. Assuming this is the user's scenario, e.g. we have 3 AZs, and only 2 EIPs
  // specified, 1/3 of the traffic coming from the VPC will be seemingly randomly rejected, which is a difficult
  // and frustrating problem to debug. Therefore, we feel it's better to be strict about the acceptable inputs to
  // avoid potentially confusing problems in production.
  switch (natGatewayStrategy) {
    case "None":
      if (eips?.length ?? 0 !== 0) {
        throw new Error(
          `Elastic IP allocation IDs cannot be specified when NAT Gateway strategy is '${natGatewayStrategy}'.`,
        );
      }
      break;
    case "Single":
      if (eips && eips.length !== 1) {
        throw new Error(
          `Exactly one Elastic IP may be specified when NAT Gateway strategy is '${natGatewayStrategy}'.`,
        );
      }
      break;
    case "OnePerAz":
      if (eips && eips.length > 0 && eips.length !== availabilityZones.length) {
        throw new Error(
          `The number of Elastic IPs, if specified, must match the number of availability zones for the VPC (${availabilityZones.length}) when NAT Gateway strategy is '${natGatewayStrategy}'`,
        );
      }
      break;
    default:
      throw new Error(`Unknown NatGatewayStrategy '${natGatewayStrategy}'`);
  }
}

export function validateNatGatewayStrategy(
  natGatewayStrategy: schema.NatGatewayStrategyInputs,
  subnets: SubnetSpec[],
) {
  // This logic assumes that the same subnets exist in every AZ:
  switch (natGatewayStrategy) {
    case "OnePerAz":
    case "Single":
      if (subnets.some((x) => x.type === "Public") && subnets.some((x) => x.type === "Private")) {
        return;
      }
      throw new Error(
        "If NAT Gateway strategy is 'OnePerAz' or 'Single', both private and public subnets must be declared. The private subnet creates the need for a NAT Gateway, and the public subnet is required to host the NAT Gateway resource.",
      );
    case "None":
      if (subnets.some((x) => x.type === "Private")) {
        throw new Error("If private subnets are specified, NAT Gateway strategy cannot be 'None'.");
      }
      break;
    default:
      throw new Error(`Unknown NAT Gateway strategy '${natGatewayStrategy}'`);
  }
}

export function shouldCreateNatGateway(
  strategy: schema.NatGatewayStrategyInputs,
  numGateways: number,
  azIndex: number,
) {
  switch (strategy) {
    case "None":
      return false;
    case "Single":
      return numGateways < 1;
    case "OnePerAz":
      return numGateways < azIndex + 1;
    default:
      throw new Error(`Unknown NatGatewayStrategy "${strategy}"`);
  }
}

export function compareSubnetSpecs(spec1: SubnetSpec, spec2: SubnetSpec): number {
  if (spec1.type === spec2.type) {
    return 0;
  }

  // Public always comes first
  if (spec1.type === "Public") {
    return -1;
  }

  if (spec1.type === "Private" && spec2.type === "Public") {
    return 1;
  }

  if (spec1.type === "Private" && spec2.type === "Isolated") {
    return -1;
  }

  // Isolated is the only remaining case, and they always come last.
  return 1;
}