"""IpverseUe5Build: one CPU box that packages the UE5 template game inside Epic's container image.

No inbound rules, SSM-managed. Work arrives as SSM RunCommand (scripts/ue5_build.sh -> ue5/Scripts/build.sh).
The box powers itself off (instance-initiated shutdown = stop) after 30 idle minutes: no build lock and no
running container. The Epic image needs a GitHub PAT of an Epic-linked account, stored by the user as
Secrets Manager `ipverse/ghcr-token` = {"username", "token"}.

Builds go to the us-west-2 bucket of IpverseStreams: a GameLift Streams application must read its files
from a bucket in its own region.
"""
import aws_cdk as cdk
from aws_cdk import aws_ec2 as ec2, aws_iam as iam
from constructs import Construct

TAG_KEY, TAG_VALUE = "ipverse", "ue5-build"
DEFAULT_VPC = "vpc-0048f3a571ac6b876"
SUBNET = ("subnet-07922e1760eeb715e", "us-east-1a")  # default VPC, public, auto-assign public IP (egress only)
INSTANCE_TYPE = "c6i.8xlarge"  # 32 vCPU / 64 GB: shader compile + C++ are CPU-bound; cook uses -nullrhi
SECRET_NAME = "ipverse/ghcr-token"
UBUNTU_2204 = "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id"
IDLE_MINUTES = 30


def builds_bucket_name(account: str) -> str:
    return f"ipverse-ue5-builds-{account}-us-west-2"


IDLE_STOP = f"""#!/bin/bash
# Power off after {IDLE_MINUTES} idle minutes (instance-initiated shutdown behaviour = stop).
state=/run/ipverse-idle-since
busy() {{ [ -e /run/ipverse-build.lock ] || [ -n "$(docker ps -q 2>/dev/null)" ]; }}
if busy; then rm -f "$state"; exit 0; fi
[ -e "$state" ] || date +%s > "$state"
if [ $(( $(date +%s) - $(cat "$state") )) -ge {IDLE_MINUTES * 60} ]; then shutdown -h now; fi
"""


class Ue5BuildStack(cdk.Stack):
    def __init__(self, scope: Construct, id: str, **kwargs):
        super().__init__(scope, id, **kwargs)
        bucket = builds_bucket_name(self.account)

        role = iam.Role(
            self, "BuildRole",
            assumed_by=iam.ServicePrincipal("ec2.amazonaws.com"),
            managed_policies=[iam.ManagedPolicy.from_aws_managed_policy_name("AmazonSSMManagedInstanceCore")],
        )
        role.add_to_policy(iam.PolicyStatement(
            actions=["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
            resources=[f"arn:aws:secretsmanager:{self.region}:{self.account}:secret:{SECRET_NAME}-*"],
        ))
        role.add_to_policy(iam.PolicyStatement(
            actions=["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
            resources=[f"arn:aws:s3:::{bucket}/ipverse-ue5/*"],
        ))
        role.add_to_policy(iam.PolicyStatement(
            actions=["s3:ListBucket"], resources=[f"arn:aws:s3:::{bucket}"],
        ))

        vpc = ec2.Vpc.from_vpc_attributes(
            self, "DefaultVpc", vpc_id=DEFAULT_VPC, availability_zones=[SUBNET[1]], public_subnet_ids=[SUBNET[0]])
        sg = ec2.SecurityGroup(self, "BuildSg", vpc=vpc, allow_all_outbound=True,
                               description="ipverse ue5 build box: egress only, no inbound")

        user_data = ec2.UserData.for_linux()
        user_data.add_commands(
            "set -eux",
            "export DEBIAN_FRONTEND=noninteractive",
            "apt-get update",
            "apt-get install -y docker.io jq git unzip pigz",
            "curl -sSfL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscli.zip",
            "unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install --update && rm -rf /tmp/aws /tmp/awscli.zip",
            "systemctl enable --now docker",
            f"echo 'UE5_BUILDS_BUCKET={bucket}' > /etc/ipverse-ue5.env",
            f"echo 'UE5_SECRET_ID={SECRET_NAME}' >> /etc/ipverse-ue5.env",
            f"echo 'AWS_DEFAULT_REGION={self.region}' >> /etc/ipverse-ue5.env",
            "cat > /usr/local/bin/ipverse-idle-stop <<'EOF'",
            IDLE_STOP.strip(),
            "EOF",
            "chmod +x /usr/local/bin/ipverse-idle-stop",
            "echo '*/5 * * * * root /usr/local/bin/ipverse-idle-stop' > /etc/cron.d/ipverse-idle-stop",
            "mkdir -p /opt/ue5",
        )

        instance = ec2.Instance(
            self, "BuildBox",
            instance_type=ec2.InstanceType(INSTANCE_TYPE),
            machine_image=ec2.MachineImage.from_ssm_parameter(UBUNTU_2204),
            vpc=vpc,
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PUBLIC),  # MapPublicIpOnLaunch=true
            security_group=sg,
            role=role,
            user_data=user_data,
            require_imdsv2=True,
            instance_initiated_shutdown_behavior=ec2.InstanceInitiatedShutdownBehavior.STOP,
            block_devices=[ec2.BlockDevice(device_name="/dev/sda1", volume=ec2.BlockDeviceVolume.ebs(
                400, volume_type=ec2.EbsDeviceVolumeType.GP3, iops=6000, throughput=500,
                delete_on_termination=True, encrypted=True))],
        )
        cdk.Tags.of(instance).add("Name", "ipverse-ue5-build")
        cdk.Tags.of(instance).add(TAG_KEY, TAG_VALUE)

        cdk.CfnOutput(self, "InstanceId", value=instance.instance_id)
        cdk.CfnOutput(self, "BuildsBucket", value=bucket)
