import { App, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Peer, Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';

export class InsecureStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new Bucket(this, 'UnencryptedBucket');

    const vpc = new Vpc(this, 'Vpc');
    const sg = new SecurityGroup(this, 'OpenSg', { vpc });
    sg.addIngressRule(Peer.anyIpv4(), Port.tcp(22));
  }
}

const app = new App();
new InsecureStack(app, 'InsecureStack');
