"""AWS Operations: compute and deployment state of one member account, Mango's own code.

Read-only MCP tools for the SRE agent: EC2 instances and their status checks, Auto Scaling
groups and their scaling activities, load balancers, target groups and target health, ECS
clusters, services, deployments and stopped tasks, CloudFormation stacks and their events, and
the configuration history of a resource in AWS Config.

Every tool answers a **curated view**: an allowlist of fields of the AWS response, a bounded
number of items and long texts cut short. Never environment variables, user data, task
definitions or overrides, stack parameters or outputs, resource properties, configuration
values or tags that are not on a short allowlist.
"""
