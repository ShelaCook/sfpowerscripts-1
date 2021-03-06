import child_process = require("child_process");
import BuildImpl, { BuildProps } from "../parallelBuilder/BuildImpl";
import DeployImpl, { DeploymentMode, DeployProps } from "../deploy/DeployImpl";
import ArtifactGenerator from "@dxatscale/sfpowerscripts.core/lib/generators/ArtifactGenerator";
import PackageMetadata from "@dxatscale/sfpowerscripts.core/lib/PackageMetadata";
import { Stage } from "../Stage";
import SFPLogger, { LoggerLevel } from "@dxatscale/sfpowerscripts.core/lib/utils/SFPLogger";
import fs = require("fs");
import InstallPackageDepenciesImpl from "@dxatscale/sfpowerscripts.core/lib/sfdxwrappers/InstallPackageDependenciesImpl";
import { PackageInstallationStatus } from "@dxatscale/sfpowerscripts.core/lib/package/PackageInstallationResult";
const Table = require("cli-table");

export enum ValidateMode {
  ORG,
  POOL
}

export interface ValidateProps {
  validateMode: ValidateMode,
  coverageThreshold: number,
  logsGroupSymbol: string[],
  targetOrg?: string,
  devHubUsername?: string,
  pools?: string[],
  jwt_key_file?: string,
  client_id?: string,
  shapeFile?: string,
  isDeleteScratchOrg?: boolean,
}

export default class ValidateImpl {

  constructor (
    private props: ValidateProps
  ){}

  public async exec(): Promise<boolean>{
    let scratchOrgUsername: string;
    try {
      if (this.props.validateMode === ValidateMode.ORG) {
        scratchOrgUsername = this.props.targetOrg;

      } else if (this.props.validateMode === ValidateMode.POOL) {
        this.authenticateDevHub(this.props.devHubUsername);

        scratchOrgUsername = this.fetchScratchOrgFromPool(
          this.props.pools,
          this.props.devHubUsername
        );

        this.authenticateToScratchOrg(scratchOrgUsername);

        if (this.props.shapeFile) {
          this.deployShapeFile(this.props.shapeFile, scratchOrgUsername);
        }
        await this.installPackageDependencies(scratchOrgUsername);
      } else throw new Error(`Unknown mode ${this.props.validateMode}`);



      let packagesToCommits: {[p: string]: string} = {};

      let queryResult = this.querySfpowerscriptsArtifactsInScratchOrg(scratchOrgUsername);
      if (queryResult) {
        if (queryResult.status === 0) {
          packagesToCommits = this.getPackagesToCommits(queryResult);
          this.printArtifactVersions(queryResult);
        } else {
          console.log("Failed to query org for Sfpowerscripts Artifacts");
          console.log("Building all packages...");
        }
      } else {
        console.log("Building all packages...");
      }

      await this.buildChangedSourcePackages(packagesToCommits);

      // Un-suppress logs for deployment
      SFPLogger.isSupressLogs = false;
      SFPLogger.logLevel = LoggerLevel.INFO;

      let deploymentResult = await this.deploySourcePackages(scratchOrgUsername);

      if (deploymentResult.failed.length > 0 || deploymentResult.error)
        return false;
      else
        return true;
    } finally {
      if (this.props.isDeleteScratchOrg) {
        this.deleteScratchOrg(scratchOrgUsername);
      } else {
          fs.writeFileSync(
            ".env",
            `sfpowerscripts_scratchorg_username=${scratchOrgUsername}\n`,
            { flag: "a" }
          );
          console.log(
            `sfpowerscripts_scratchorg_username=${scratchOrgUsername}`
          );
        }
    }

  }

  private async installPackageDependencies(scratchOrgUsername: string) {
    this.printOpenLoggingGroup(`Installing Package Dependencies of this repo in ${scratchOrgUsername}`);
    SFPLogger.isSupressLogs=false;
    // Install Dependencies
    let installDependencies: InstallPackageDepenciesImpl = new InstallPackageDepenciesImpl(
      scratchOrgUsername,
      this.props.devHubUsername,
      120,
      null,
      null,
      true,
      null
    );
    let installationResult = await installDependencies.exec();
    if (installationResult.result == PackageInstallationStatus.Failed) {
      throw new Error(installationResult.message);
    }
    console.log(`Successfully completed Installing Package Dependencies of this repo in ${scratchOrgUsername}`);
    this.printClosingLoggingGroup();
  }

  private deleteScratchOrg(scratchOrgUsername: string): void {
    try {
      if (scratchOrgUsername && this.props.devHubUsername ) {
          console.log(`Deleting scratch org`, scratchOrgUsername);
          child_process.execSync(
            `sfdx force:org:delete -p -u ${scratchOrgUsername} -v ${this.props.devHubUsername}`,
            {
              stdio: 'inherit',
              encoding: 'utf8'
            }
          );
      }
    } catch (error) {
      console.log(error.message);
    }
  }

  private authenticateDevHub(devHubUsername: string): void {
    child_process.execSync(
      `sfdx auth:jwt:grant -u ${devHubUsername} -i ${this.props.client_id} -f ${this.props.jwt_key_file} -r https://login.salesforce.com`,
      {
        stdio: "inherit",
        encoding: "utf8"
      }
    );
  }

  private deployShapeFile(shapeFile: string, scratchOrgUsername: string): void {
    console.log(`Deploying scratch org shape`, shapeFile);
    child_process.execSync(
      `sfdx force:mdapi:deploy -f ${shapeFile} -u ${scratchOrgUsername} -w 30 --ignorewarnings`,
      {
        stdio: 'inherit',
        encoding: 'utf8'
      }
    );
  }

  private async deploySourcePackages(scratchOrgUsername: string): Promise<{
    deployed: string[],
    skipped: string[],
    failed: string[],
    testFailure: string,
    error: any
  }> {
    let deployStartTime: number = Date.now();

    let deployProps: DeployProps = {
       targetUsername : scratchOrgUsername,
       artifactDir : "artifacts",
       waitTime:120,
       deploymentMode:DeploymentMode.SOURCEPACKAGES,
       isTestsToBeTriggered:true,
       skipIfPackageInstalled:false,
       coverageThreshold:this.props.coverageThreshold,
       logsGroupSymbol:this.props.logsGroupSymbol,
       currentStage:Stage.VALIDATE,
    }


    let deployImpl: DeployImpl = new DeployImpl(
     deployProps
    );

    let deploymentResult = await deployImpl.exec();

    let deploymentElapsedTime: number = Date.now() - deployStartTime;
    this.printDeploySummary(deploymentResult, deploymentElapsedTime);

    return deploymentResult;
  }

  private async buildChangedSourcePackages(packagesToCommits: { [p: string]: string; }): Promise<void> {
    let buildStartTime: number = Date.now();


     let buildProps:BuildProps = {
       buildNumber:1,
       executorcount:10,
       waitTime:120,
       isDiffCheckEnabled:true,
       isQuickBuild:true,
       isBuildAllAsSourcePackages:true,
       packagesToCommits:packagesToCommits,
       currentStage:Stage.VALIDATE
     }



    let buildImpl: BuildImpl = new BuildImpl(buildProps);

    let { generatedPackages, failedPackages } = await buildImpl.exec();

    if (failedPackages.length > 0)
      throw new Error(`Failed to create source packages ${failedPackages}`);


    for (let generatedPackage of generatedPackages) {
      try {
        await ArtifactGenerator.generateArtifact(
          generatedPackage.package_name,
          process.cwd(),
          "artifacts",
          generatedPackage
        );
      } catch (error) {
        console.log(
          `Unable to create artifact for ${generatedPackage.package_name}`
        );
        throw error;
      }
    }
    let buildElapsedTime: number = Date.now() - buildStartTime;

    this.printBuildSummary(generatedPackages, failedPackages, buildElapsedTime);
  }

  private getPackagesToCommits(queryResult: any): {[p: string]: string} {
    let packagesToCommits: {[p: string]: string} = {};

    // Construct map of artifact and associated commit Id
    queryResult.result.records.forEach((artifact) => {
      packagesToCommits[artifact.Name] = artifact.CommitId__c;
    });

    return packagesToCommits;
  }

  private printArtifactVersions(queryResult: any) {
    this.printOpenLoggingGroup(`Artifacts installed in the Scratch Org"`);
    let table = new Table({
      head: ["Artifact", "Version", "Commit Id"],
    });

    queryResult.result.records.forEach((artifact) => {
      table.push([artifact.Name, artifact.Version__c, artifact.CommitId__c]);
    });

    console.log(`Artifacts installed in scratch org:`);
    console.log(table.toString());
    this.printClosingLoggingGroup();
  }

  /**
   * Query SfpowerscriptsArtifact__c records in scratch org. Returns query result as JSON if records are found,
   * otherwise returns null.
   * @param scratchOrgUsername
   */
  private querySfpowerscriptsArtifactsInScratchOrg(scratchOrgUsername): any {
    let queryResultJson: string;
    try {
     
      queryResultJson = child_process.execSync(
        `sfdx force:data:soql:query -q "SELECT Id, Name, CommitId__c, Version__c, Tag__c FROM SfpowerscriptsArtifact__c" -r json -u ${scratchOrgUsername}`,
        {
          stdio: "pipe",
          encoding: "utf8"
        }
      );
    } catch (error) {}

    if (queryResultJson) {
      return JSON.parse(queryResultJson);
    } else {
      console.log("Failed to query org for Sfpowerscripts Artifacts");
      return null;
    }
    
  }

  private authenticateToScratchOrg(scratchOrgUsername: string): void {
    child_process.execSync(
      `sfdx auth:jwt:grant -u ${scratchOrgUsername} -i ${this.props.client_id} -f ${this.props.jwt_key_file} -r https://test.salesforce.com`,
      {
        stdio: ['ignore', 'inherit', 'inherit']
      }
    );
  }

  private fetchScratchOrgFromPool(pools: string[], devHubUsername: string): string {
    let scratchOrgUsername: string;

    for (let pool of pools) {
      let fetchResultJson: string;
      try {
        fetchResultJson = child_process.execSync(
          `sfdx sfpowerkit:pool:fetch -t ${pool.trim()} -v ${devHubUsername} --json`,
          {
            stdio: 'pipe',
            encoding: 'utf8'
          }
        );
      } catch (error) {}

      if (fetchResultJson) {
        let fetchResult = JSON.parse(fetchResultJson);
        if (fetchResult.status === 0) {
          scratchOrgUsername = fetchResult.result.username;
          console.log(`Fetched scratch org ${scratchOrgUsername} from ${pool}`);
          break;
        }
      }
    }

    if (scratchOrgUsername)
      return scratchOrgUsername;
    else
      throw new Error(`Failed to fetch scratch org from ${pools}`);
  }

  private printBuildSummary(
    generatedPackages: PackageMetadata[],
    failedPackages: string[],
    totalElapsedTime: number
  ): void {
    console.log(
      `----------------------------------------------------------------------------------------------------`
    );
    console.log(
      `${
        generatedPackages.length
      } packages created in ${new Date(totalElapsedTime).toISOString().substr(11,8)
      } with {${failedPackages.length}} errors`
    );



    if (failedPackages.length > 0) {
      console.log(`Packages Failed To Build`, failedPackages);
    }
    console.log(
      `----------------------------------------------------------------------------------------------------`
    );
  }

  private printDeploySummary(
    deploymentResult: {deployed: string[], skipped: string[], failed: string[], testFailure: string},
    totalElapsedTime: number
  ): void {
    if (this.props.logsGroupSymbol?.[0])
      console.log(this.props.logsGroupSymbol[0], "Deployment Summary");

    console.log(
      `----------------------------------------------------------------------------------------------------`
    );
    console.log(
      `${deploymentResult.deployed.length} packages deployed in ${new Date(totalElapsedTime).toISOString().substr(11,8)
      } with {${deploymentResult.failed.length}} failed deployments and {${deploymentResult.skipped.length}} skipped`
    );

    if (deploymentResult.testFailure)
      console.log(`\nTests failed for`, deploymentResult.testFailure);

    if (deploymentResult.skipped.length > 0) {
      console.log(`\nPackages Skipped`, deploymentResult.skipped);
    }

    if (deploymentResult.failed.length > 0) {
      console.log(`\nPackages Failed to Deploy`, deploymentResult.failed);
    }
    console.log(
      `----------------------------------------------------------------------------------------------------`
    );
    this.printClosingLoggingGroup();
  }

  private printOpenLoggingGroup(message:string) {
    if (this.props.logsGroupSymbol?.[0])
      SFPLogger.log(
        this.props.logsGroupSymbol[0],
        `${message}`,
        null,
        LoggerLevel.INFO
      );
  }

  private printClosingLoggingGroup() {
    if (this.props.logsGroupSymbol?.[1])
      SFPLogger.log(
        this.props.logsGroupSymbol[1],
        null,
        null,
        LoggerLevel.INFO
      );
  }

}
