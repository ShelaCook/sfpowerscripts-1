import child_process = require("child_process");

export default class ExecuteCommand
{
 
   public execCommand(command:string, workingdirectory:string):Promise<any>
   {
    return new Promise((resolve, reject) => {

      try
      {
      let childProcess = child_process.exec(command, {
        encoding: "utf8",
        cwd: workingdirectory,
      });

     
      // variables for collecting data written to STDOUT and STDERR
      let stdoutContents = ''
      let stderrContents = ''
  
      // collect data written to STDOUT into a string
      childProcess.stdout.on('data', (data) => {
        stdoutContents += data.toString()
      });
  
      // collect data written to STDERR into a string
      childProcess.stderr.on('data', (data) => {
        stderrContents += data.toString()
      });
  

      childProcess.once('close', (code: number, signal: string) => {

        if (code === 0 || (code === null && signal === "SIGTERM")) {
          resolve(stdoutContents);
        } else {
          if(stderrContents)
          reject(new Error(stderrContents));
        }
      });


      childProcess.once('error', (err: Error) => {
        if(stderrContents)
        reject(new Error(stderrContents));
      });
      }
      catch(error)
      {
        reject(error);
      }
    });
   }
   
}