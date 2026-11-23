"""IpverseImg3d: one L40S box (g6e.*) running Hunyuan3D-2.1 behind an SQS queue.

No inbound rules: the worker long-polls SQS, reads/writes s3://ipverse-assets-…/img3d/*, and stops itself
after 20 idle minutes. The stack owns no instance: the API Lambda (IpverseCore, server/providers/img3d.py)
starts the box tagged ipverse=img3d, or launches one from the `ipverse-img3d` launch template in whichever
AZ/type has g6e capacity, and retires the stranded one. The template's AMI has the venv, weights and worker.
"""
import aws_cdk as cdk
from aws_cdk import Duration, aws_ec2 as ec2, aws_iam as iam, aws_sqs as sqs
from constructs import Construct

QUEUE_NAME = "ipverse-img3d-jobs"
TAG_KEY, TAG_VALUE = "ipverse", "img3d"
LAUNCH_TEMPLATE_NAME = "ipverse-img3d"
# ipverse-img3d-20261030: Deep Learning OSS Nvidia Driver AMI (GPU PyTorch 2.7, Ubuntu 22.04) plus setup.sh (Python
# 3.10 venv, Hunyuan3D-2.1, weights). The bare DLAMI also works (first boot installs everything, ~35 min).
# Override: -c img3dAmi=ami-...
AMI_ID = "ami-032da630dc1c31744"
DEFAULT_VPC = "vpc-0048f3a571ac6b876"
DEFAULT_TYPE = "g6e.xlarge"  # RunInstances overrides it (g6e.xlarge → 2xlarge → 4xlarge, same L40S)


class Img3dStack(cdk.Stack):
    def __init__(self, scope: Construct, id: str, **kwargs):
        super().__init__(scope, id, **kwargs)
        bucket_name = f"ipverse-assets-{self.account}-{self.region}"

        dlq = sqs.Queue(self, "JobsDlq", queue_name=f"{QUEUE_NAME}-dlq", retention_period=Duration.days(14))
        queue = sqs.Queue(
            self, "Jobs", queue_name=QUEUE_NAME,
            visibility_timeout=Duration.minutes(30),
            retention_period=Duration.days(1),
            dead_letter_queue=sqs.DeadLetterQueue(queue=dlq, max_receive_count=2),
        )
        # One message group in a FIFO queue serves every session's meshes first in, first out.
        fifo_dlq = sqs.Queue(self, "JobsFifoDlq", queue_name=f"{QUEUE_NAME}-dlq.fifo", fifo=True,
                             retention_period=Duration.days(14))
        fifo = sqs.Queue(
            self, "JobsFifo", queue_name=f"{QUEUE_NAME}.fifo", fifo=True,
            visibility_timeout=Duration.minutes(10),  # the worker's heartbeat extends it every 60 s
            retention_period=Duration.days(1),
            dead_letter_queue=sqs.DeadLetterQueue(queue=fifo_dlq, max_receive_count=2),
        )

        role = iam.Role(
            self, "WorkerRole",
            assumed_by=iam.ServicePrincipal("ec2.amazonaws.com"),
            managed_policies=[iam.ManagedPolicy.from_aws_managed_policy_name("AmazonSSMManagedInstanceCore")],
        )
        role.add_to_policy(iam.PolicyStatement(
            actions=["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility",
                     "sqs:GetQueueAttributes"],
            resources=[queue.queue_arn, fifo.queue_arn],
        ))
        role.add_to_policy(iam.PolicyStatement(
            actions=["s3:GetObject", "s3:PutObject"],
            resources=[f"arn:aws:s3:::{bucket_name}/img3d/*"],
        ))
        # self-stop: the only instance carrying this tag is the worker itself
        role.add_to_policy(iam.PolicyStatement(
            actions=["ec2:StopInstances"],
            resources=[f"arn:aws:ec2:{self.region}:{self.account}:instance/*"],
            conditions={"StringEquals": {f"aws:ResourceTag/{TAG_KEY}": TAG_VALUE}},
        ))

        vpc = ec2.Vpc.from_vpc_attributes(
            self, "DefaultVpc", vpc_id=DEFAULT_VPC, availability_zones=["us-east-1a"],
            public_subnet_ids=["subnet-07922e1760eeb715e"])  # only the SG uses it
        sg = ec2.SecurityGroup(self, "WorkerSg", vpc=vpc, allow_all_outbound=True,
                               description="ipverse img3d worker: egress only, no inbound")

        user_data = ec2.UserData.for_linux()
        user_data.add_commands(
            "set -eux",
            "cat > /etc/img3d.env <<EOF",
            f"IMG3D_BUCKET={bucket_name}",
            f"IMG3D_QUEUE_URL={fifo.queue_url}",
            f"AWS_REGION={self.region}",
            f"AWS_DEFAULT_REGION={self.region}",
            "EOF",
            "mkdir -p /opt/img3d",
            f"until aws s3 cp s3://{bucket_name}/img3d/worker/setup.sh /opt/img3d/setup.sh; do sleep 20; done",
            "nohup bash /opt/img3d/setup.sh >/dev/null 2>&1 &",
        )

        self.worker_role = role
        self.launch_template = ec2.LaunchTemplate(
            self, "WorkerTemplate",
            launch_template_name=LAUNCH_TEMPLATE_NAME,
            instance_type=ec2.InstanceType(DEFAULT_TYPE),
            machine_image=ec2.MachineImage.generic_linux({self.region: self.node.try_get_context("img3dAmi") or AMI_ID}),
            security_group=sg,
            role=role,
            user_data=user_data,  # re-runs setup.sh per new instance: env file, latest worker.py, service start
            require_imdsv2=True,
            block_devices=[ec2.BlockDevice(device_name="/dev/sda1", volume=ec2.BlockDeviceVolume.ebs(
                200, volume_type=ec2.EbsDeviceVolumeType.GP3, delete_on_termination=True))],
        )
        # A volume restored from the AMI snapshot fetches blocks from S3 lazily (18 GB of weights): provisioned volume
        # initialization pulls the snapshot at a fixed 300 MiB/s (the maximum) instead.
        self.launch_template.node.default_child.add_property_override(
            "LaunchTemplateData.BlockDeviceMappings.0.Ebs.VolumeInitializationRate", 300)
        cdk.Tags.of(self.launch_template).add("Name", "ipverse-img3d")
        cdk.Tags.of(self.launch_template).add(TAG_KEY, TAG_VALUE)

        cdk.CfnOutput(self, "QueueUrl", value=queue.queue_url)
        cdk.CfnOutput(self, "FifoQueueUrl", value=fifo.queue_url)
        cdk.CfnOutput(self, "LaunchTemplateId", value=self.launch_template.launch_template_id)
